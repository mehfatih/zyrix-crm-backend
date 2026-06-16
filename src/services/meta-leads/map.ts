// ============================================================================
// META LEAD ADS — MAP field_data → contact + deal + attribution
// ----------------------------------------------------------------------------
// Maps a fetched lead's field_data to a CRM contact (deduped by phone/email
// within companyId), creates a deal in the first pipeline stage ("lead"), and
// records attribution in lead_sources. Idempotent on leadgen_id so Meta
// retries never create duplicate contacts/deals.
//
// AR/i18n: Meta standardizes well-known question KEYS in English (full_name,
// email, phone_number, …) regardless of the form's localized labels. We match
// on the field `name` (the key), NOT the label. Unknown/custom questions are
// preserved in the contact's customFields so nothing is lost.
// ============================================================================

import { randomUUID } from "crypto";
import { prisma } from "../../config/database";
import { dispatchLeadCaptured } from "../workflow-events.service";
import { captureLeadAdStamp } from "../lead-source-capture.service";
import type { FetchedLead, LeadFieldDatum } from "./fetch";

// Known Meta lead-form field keys → CRM contact fields. Match by key.
const KEY_MAP: Record<string, "fullName" | "firstName" | "lastName" | "email" | "phone" | "companyName" | "position" | "city" | "country"> = {
  full_name: "fullName",
  first_name: "firstName",
  last_name: "lastName",
  email: "email",
  phone_number: "phone",
  company_name: "companyName",
  job_title: "position",
  city: "city",
  country: "country",
};

interface MappedContact {
  fullName: string;
  email: string | null;
  phone: string | null;
  companyName: string | null;
  position: string | null;
  city: string | null;
  country: string | null;
  custom: Record<string, string>;
}

function firstValue(f: LeadFieldDatum): string {
  return (f.values && f.values.length ? f.values[0] : "").trim();
}

/** Reduce field_data to known CRM fields (by key) + a custom bag for the rest. */
export function mapFieldData(fieldData: LeadFieldDatum[]): MappedContact {
  let firstName = "";
  let lastName = "";
  const out: MappedContact = {
    fullName: "",
    email: null,
    phone: null,
    companyName: null,
    position: null,
    city: null,
    country: null,
    custom: {},
  };
  for (const f of fieldData) {
    const key = (f.name || "").toLowerCase().trim();
    const val = firstValue(f);
    if (!val) continue;
    const target = KEY_MAP[key];
    switch (target) {
      case "fullName": out.fullName = val; break;
      case "firstName": firstName = val; break;
      case "lastName": lastName = val; break;
      case "email": out.email = val; break;
      case "phone": out.phone = val; break;
      case "companyName": out.companyName = val; break;
      case "position": out.position = val; break;
      case "city": out.city = val; break;
      case "country": out.country = val; break;
      default: out.custom[f.name] = val; // unknown/custom question — keep verbatim key
    }
  }
  if (!out.fullName) {
    out.fullName = [firstName, lastName].filter(Boolean).join(" ").trim() || out.email || out.phone || "Meta Lead";
  }
  return out;
}

const digits = (s: string | null | undefined): string => (s ? s.replace(/\D/g, "") : "");

/**
 * Find an existing contact by phone (digits) or email within the company, else
 * create one. Returns the contact id.
 */
async function upsertContact(companyId: string, m: MappedContact): Promise<string> {
  const phoneDigits = digits(m.phone);
  const or: Array<Record<string, unknown>> = [];
  if (m.email) or.push({ email: { equals: m.email, mode: "insensitive" } });
  if (phoneDigits.length >= 6) {
    or.push({ phone: { contains: phoneDigits.slice(-9) } });
    or.push({ whatsappPhone: { contains: phoneDigits.slice(-9) } });
  }
  if (or.length) {
    const existing = await prisma.customer.findFirst({
      where: { companyId, OR: or as never },
      select: { id: true },
    });
    if (existing) return existing.id;
  }
  const created = await prisma.customer.create({
    data: {
      companyId,
      fullName: m.fullName,
      email: m.email,
      phone: m.phone,
      companyName: m.companyName,
      position: m.position,
      country: m.country,
      city: m.city,
      source: "meta_lead_ad",
      status: "new",
      customFields: Object.keys(m.custom).length ? (m.custom as never) : undefined,
    },
    select: { id: true },
  });
  return created.id;
}

export interface IngestResult {
  idempotent: boolean; // true = already processed (no new contact/deal)
  contactId?: string;
  dealId?: string;
}

/**
 * Idempotent ingest of a fetched lead. If leadgen_id was already processed,
 * returns { idempotent: true } without creating anything.
 */
export async function ingestLead(params: {
  companyId: string;
  lead: FetchedLead;
  pageId: string;
}): Promise<IngestResult> {
  const { companyId, lead, pageId } = params;

  // Idempotency guard — leadgenId is UNIQUE in lead_sources.
  const seen = (await prisma.$queryRawUnsafe(
    `SELECT "id" FROM lead_sources WHERE "leadgenId" = $1 LIMIT 1`,
    lead.id
  )) as Array<{ id: string }>;
  if (seen.length) return { idempotent: true };

  const mapped = mapFieldData(lead.fieldData);
  const contactId = await upsertContact(companyId, mapped);

  const deal = await prisma.deal.create({
    data: {
      companyId,
      customerId: contactId,
      title: mapped.fullName ? `Lead: ${mapped.fullName}` : "Meta Lead",
      stage: "lead", // first pipeline stage
      value: 0,
      currency: "USD",
      description: "Imported from Meta Lead Ad",
    },
    select: { id: true },
  });

  // platform: Meta returns "fb"/"ig" or "facebook"/"instagram" — normalize.
  const platform = lead.platform
    ? /ig|insta/i.test(lead.platform)
      ? "ig"
      : /fb|face/i.test(lead.platform)
        ? "fb"
        : lead.platform
    : null;

  // Insert attribution. ON CONFLICT (leadgenId) DO NOTHING is the race backstop
  // for concurrent Meta retries (the pre-check above handles the common case).
  await prisma.$executeRawUnsafe(
    `INSERT INTO lead_sources
       ("id","companyId","contactId","dealId","source","leadgenId","campaignId","adsetId","adId","formId","pageId","platform","rawJson","createdAt")
     VALUES ($1,$2,$3,$4,'meta_lead_ad',$5,$6,$7,$8,$9,$10,$11,$12::jsonb,NOW())
     ON CONFLICT ("leadgenId") DO NOTHING`,
    randomUUID(),
    companyId,
    contactId,
    deal.id,
    lead.id,
    lead.campaignId,
    lead.adsetId,
    lead.adId,
    lead.formId,
    pageId,
    platform,
    JSON.stringify({ fieldKeys: lead.fieldData.map((f) => f.name), createdTime: lead.createdTime })
  );

  // Sprint 25E — stamp deals.attributionSource (gated by source_attribution,
  // fire-safe) alongside the lead_sources row written above.
  void captureLeadAdStamp(companyId, deal.id, "meta_lead_ad");

  // Fire the lead.captured automation trigger (fire-and-forget — ingest must
  // succeed even if no workflow matches or matching errors).
  dispatchLeadCaptured(
    companyId,
    {
      id: contactId,
      fullName: mapped.fullName ?? "Lead",
      email: mapped.email ?? null,
      phone: mapped.phone ?? null,
      status: "new",
      source: "meta_lead_ad",
    },
    {
      id: deal.id,
      title: mapped.fullName ? `Lead: ${mapped.fullName}` : "Meta Lead",
      value: 0,
      currency: "USD",
      stage: "lead",
      customerId: contactId,
    },
    "meta_lead_ad"
  ).catch(() => {});

  return { idempotent: false, contactId, dealId: deal.id };
}
