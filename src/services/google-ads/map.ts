// ============================================================================
// GOOGLE ADS LEAD FORMS — MAP user_column_data → contact + deal + attribution
// ----------------------------------------------------------------------------
// Mirrors the Meta Lead Ads ingest (services/meta-leads/map.ts) but the full
// lead arrives in the webhook POST — no Graph fetch. Maps Google's
// `user_column_data: [{column_id, string_value}]` to a CRM contact (deduped by
// phone/email within companyId, SAME rule as Meta), creates a deal in the
// configured "New lead" stage, and records attribution in the shared
// lead_sources table with source='google_ads_lead'. Idempotent on the Google
// lead_id (stored as leadgenId='gads:<lead_id>', UNIQUE) so Google retries
// never create duplicate contacts/deals. Fires the Sprint 6 lead.captured event.
//
// Per-company `mapping` (column_id → CRM field) overrides the smart defaults
// below. Standard Google lead-form column ids are UPPERCASE keys; custom
// questions carry their own ids and are preserved verbatim in customFields.
// ============================================================================

import { randomUUID } from "crypto";
import { prisma } from "../../config/database";
import { dispatchLeadCaptured } from "../workflow-events.service";

export type CrmField =
  | "fullName"
  | "firstName"
  | "lastName"
  | "email"
  | "phone"
  | "companyName"
  | "position"
  | "city"
  | "country";

// Smart defaults: Google standard column_id → CRM field. Matched case-insensitively.
const DEFAULT_COLUMN_MAP: Record<string, CrmField> = {
  FULL_NAME: "fullName",
  FIRST_NAME: "firstName",
  LAST_NAME: "lastName",
  EMAIL: "email",
  PHONE_NUMBER: "phone",
  COMPANY_NAME: "companyName",
  JOB_TITLE: "position",
  CITY: "city",
  COUNTRY: "country",
};

const VALID_FIELDS = new Set<CrmField>([
  "fullName",
  "firstName",
  "lastName",
  "email",
  "phone",
  "companyName",
  "position",
  "city",
  "country",
]);

export interface GoogleLeadColumn {
  column_id?: string;
  string_value?: string;
}

export interface GoogleLeadPayload {
  lead_id?: string;
  api_version?: string;
  form_id?: string;
  campaign_id?: string;
  google_key?: string;
  is_test?: boolean;
  gcl_id?: string;
  adgroup_id?: string;
  creative_id?: string;
  user_column_data?: GoogleLeadColumn[];
}

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

// ISO-3166 alpha-2 → E.164 dialing code, for the countries Zyrix supports
// (mirrors lib/locale/country-profiles phonePrefix on the web). Used to infer
// the country code for bare NATIONAL numbers from the company's own country
// rather than hardcoding one market.
const DIAL_CODES: Record<string, string> = {
  TR: "90",
  SA: "966",
  AE: "971",
  EG: "20",
  KW: "965",
  QA: "974",
  BH: "973",
  OM: "968",
  IQ: "964",
};

/** Resolve a company country (ISO-2, case-insensitive) to its dialing code. */
export function dialCodeForCountry(country: string | null | undefined): string | null {
  if (!country) return null;
  return DIAL_CODES[country.trim().toUpperCase()] ?? null;
}

/**
 * E.164 normalization. Numbers that already carry an international prefix are
 * canonicalized unchanged in meaning: a leading '+' is kept, a leading '00' is
 * turned into '+', and spaces/punctuation are stripped (this is how Google
 * actually delivers leads). For a BARE NATIONAL number (no + / 00) we infer the
 * company's `defaultDialCode` when provided — dropping a leading trunk '0'
 * (e.g. TR "0532 415 67 89" + "90" → "+905324156789"; SA "0501234567" + "966"
 * → "+966501234567"). With no country context the digits are left as-is.
 */
export function normalizeE164(raw: string, defaultDialCode?: string | null): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return "";
  if (hasPlus) return "+" + digits; // already international
  if (digits.startsWith("00")) return "+" + digits.slice(2); // 00 intl prefix → +
  // Bare national → infer the company's country code, dropping a trunk 0.
  if (defaultDialCode) return "+" + defaultDialCode + digits.replace(/^0+/, "");
  return digits; // no country context — leave as-is
}

/** Reduce user_column_data to known CRM fields (by column_id) + a custom bag. */
export function mapColumns(
  columns: GoogleLeadColumn[],
  mappingOverride: Record<string, string> | null,
  defaultDialCode?: string | null
): MappedContact {
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

  for (const col of columns) {
    const id = (col.column_id || "").trim();
    const val = (col.string_value || "").trim();
    if (!id || !val) continue;

    // Per-company override wins; else fall back to the case-insensitive default.
    const overridden = mappingOverride?.[id];
    const target: CrmField | undefined =
      overridden && VALID_FIELDS.has(overridden as CrmField)
        ? (overridden as CrmField)
        : DEFAULT_COLUMN_MAP[id.toUpperCase()];

    switch (target) {
      case "fullName": out.fullName = val; break;
      case "firstName": firstName = val; break;
      case "lastName": lastName = val; break;
      case "email": out.email = val; break;
      case "phone": out.phone = normalizeE164(val, defaultDialCode); break;
      case "companyName": out.companyName = val; break;
      case "position": out.position = val; break;
      case "city": out.city = val; break;
      case "country": out.country = val; break;
      default: out.custom[id] = val; // custom question — keep verbatim id
    }
  }

  if (!out.fullName) {
    out.fullName =
      [firstName, lastName].filter(Boolean).join(" ").trim() ||
      out.email ||
      out.phone ||
      "Google Ads Lead";
  }
  return out;
}

const digits = (s: string | null | undefined): string => (s ? s.replace(/\D/g, "") : "");

/** Dedupe by phone (last-9 digits) or email within the company — SAME as Meta. */
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
      source: "google_ads_lead",
      status: "new",
      customFields: Object.keys(m.custom).length ? (m.custom as never) : undefined,
    },
    select: { id: true },
  });
  return created.id;
}

export interface IngestResult {
  idempotent: boolean;
  contactId?: string;
  dealId?: string;
  isTest: boolean;
}

/**
 * Idempotent ingest of a Google Ads lead. If the lead_id was already processed,
 * returns { idempotent: true } without creating anything. Never depends on a
 * network round-trip — the payload is complete.
 */
export async function ingestGoogleLead(params: {
  companyId: string;
  payload: GoogleLeadPayload;
  mapping: Record<string, string> | null;
  defaultPipelineStage: string | null;
}): Promise<IngestResult> {
  const { companyId, payload, mapping, defaultPipelineStage } = params;
  const isTest = payload.is_test === true;

  const rawLeadId = payload.lead_id ? String(payload.lead_id) : randomUUID();
  // Namespace to avoid any collision with Meta leadgen ids in the shared
  // lead_sources.leadgenId UNIQUE column.
  const leadgenId = `gads:${rawLeadId}`;

  // Idempotency guard — leadgenId is UNIQUE in lead_sources.
  const seen = (await prisma.$queryRawUnsafe(
    `SELECT "id" FROM lead_sources WHERE "leadgenId" = $1 LIMIT 1`,
    leadgenId
  )) as Array<{ id: string }>;
  if (seen.length) return { idempotent: true, isTest };

  // Infer the default dialing code from the company's country so bare national
  // numbers normalize to E.164 for this tenant's market (TR→+90, SA→+966, …).
  const companyRow = await prisma.company.findUnique({
    where: { id: companyId },
    select: { country: true },
  });
  const defaultDialCode = dialCodeForCountry(companyRow?.country);

  const mapped = mapColumns(payload.user_column_data ?? [], mapping, defaultDialCode);
  const contactId = await upsertContact(companyId, mapped);

  const stage = defaultPipelineStage?.trim() || "lead";
  const dealTitle = mapped.fullName ? `Lead: ${mapped.fullName}` : "Google Ads Lead";
  const deal = await prisma.deal.create({
    data: {
      companyId,
      customerId: contactId,
      title: dealTitle,
      stage,
      value: 0,
      currency: "USD",
      description: isTest
        ? "Imported from Google Ads Lead Form (TEST)"
        : "Imported from Google Ads Lead Form",
    },
    select: { id: true },
  });

  // Attribution → shared lead_sources. ON CONFLICT (leadgenId) DO NOTHING is the
  // race backstop for concurrent Google retries. Google's adgroup_id maps to
  // adsetId and creative_id to adId (closest analogues); gclid + isTest live in
  // rawJson (no dedicated columns, no schema change).
  await prisma.$executeRawUnsafe(
    `INSERT INTO lead_sources
       ("id","companyId","contactId","dealId","source","leadgenId","campaignId","adsetId","adId","formId","pageId","platform","rawJson","createdAt")
     VALUES ($1,$2,$3,$4,'google_ads_lead',$5,$6,$7,$8,$9,NULL,'google',$10::jsonb,NOW())
     ON CONFLICT ("leadgenId") DO NOTHING`,
    randomUUID(),
    companyId,
    contactId,
    deal.id,
    leadgenId,
    payload.campaign_id ?? null,
    payload.adgroup_id ?? null,
    payload.creative_id ?? null,
    payload.form_id ?? null,
    JSON.stringify({
      gclid: payload.gcl_id ?? null,
      isTest,
      apiVersion: payload.api_version ?? null,
      columnIds: (payload.user_column_data ?? []).map((c) => c.column_id),
    })
  );

  // Fire the Sprint 6 lead.captured automation trigger (fire-and-forget).
  dispatchLeadCaptured(
    companyId,
    {
      id: contactId,
      fullName: mapped.fullName ?? "Lead",
      email: mapped.email ?? null,
      phone: mapped.phone ?? null,
      status: "new",
      source: "google_ads_lead",
    },
    {
      id: deal.id,
      title: dealTitle,
      value: 0,
      currency: "USD",
      stage,
      customerId: contactId,
    },
    "google_ads_lead"
  ).catch(() => {});

  return { idempotent: false, contactId, dealId: deal.id, isTest };
}
