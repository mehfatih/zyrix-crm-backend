// ============================================================================
// LEAD-SOURCE CAPTURE (Sprint 25 Phase C) — landing / web-form UTM auto-capture.
// ----------------------------------------------------------------------------
// A public form or landing CTA collects the visitor's UTM params + ad click ids
// (fbclid/gclid/ttclid/…) from location.search and posts them alongside the form
// data. After the contact/deal are created we record a lead_sources audit row
// (source='landing_utm', captureMethod='auto') and stamp the deal — respecting
// the manual-precedence rule (stampAttributionAuto skips a manually-tagged deal).
//
// Gated by the `source_attribution` entitlement (STARTER_UP): free tenants don't
// auto-capture. ALWAYS fire-safe — never throws into the form-submit path.
// ============================================================================

import { randomUUID } from "crypto";
import { prisma } from "../config/database";
import { isEnabled } from "./entitlements.service";
import { stampAttributionAuto } from "./deal-attribution.service";

const LANDING_SOURCE = "landing_utm";

// Known ad click-id params → the platform that issued them. Matched case-insensitively.
const CLICK_ID_PLATFORM: Array<{ param: string; platform: string }> = [
  { param: "fbclid", platform: "meta" },
  { param: "gclid", platform: "google" },
  { param: "gbraid", platform: "google" },
  { param: "wbraid", platform: "google" },
  { param: "ttclid", platform: "tiktok" },
  { param: "sccid", platform: "snapchat" },
  { param: "twclid", platform: "twitter" },
  { param: "li_fat_id", platform: "linkedin" },
  { param: "msclkid", platform: "other" }, // Microsoft/Bing — not a tracked ad platform
];

// Bare utm_source values → unified platform (best-effort; used only when no click id).
function platformFromUtmSource(utmSource: string | null): string | null {
  if (!utmSource) return null;
  const s = utmSource.toLowerCase();
  if (/(facebook|instagram|\bfb\b|\big\b|meta)/.test(s)) return "meta";
  if (/(google|youtube|\byt\b|adwords)/.test(s)) return "google";
  if (/(tiktok|\btt\b)/.test(s)) return "tiktok";
  if (/snap/.test(s)) return "snapchat";
  if (/(twitter|\bx\b|t\.co)/.test(s)) return "twitter";
  if (/linkedin/.test(s)) return "linkedin";
  return null;
}

export interface ParsedAttribution {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  clickId: string | null;
  clickIdParam: string | null;
  platform: string | null;
  referrer: string | null;
  landingPath: string | null;
  hasSignal: boolean; // true when at least one UTM/click id was present
  rawAll: Record<string, string>; // the full (truncated) param bag for rawJson
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, 500) : null;
}

/** Normalize a loose {param: value} bag (lowercased keys) into attribution fields. */
export function parseAttributionParams(raw: unknown): ParsedAttribution {
  const bag: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const key = k.toLowerCase().trim();
      const val = str(v);
      if (key && val) bag[key] = val;
    }
  }

  const utmSource = bag["utm_source"] ?? null;
  const utmMedium = bag["utm_medium"] ?? null;
  const utmCampaign = bag["utm_campaign"] ?? null;
  const utmTerm = bag["utm_term"] ?? null;
  const utmContent = bag["utm_content"] ?? null;
  const referrer = bag["referrer"] ?? bag["referer"] ?? null;
  const landingPath = bag["landing_path"] ?? bag["path"] ?? null;

  // First present click id wins for the clickId column; its issuer sets platform.
  let clickId: string | null = null;
  let clickIdParam: string | null = null;
  let platform: string | null = null;
  for (const { param, platform: p } of CLICK_ID_PLATFORM) {
    if (bag[param]) {
      clickId = bag[param];
      clickIdParam = param;
      platform = p;
      break;
    }
  }
  if (!platform) platform = platformFromUtmSource(utmSource);

  const hasSignal =
    !!(utmSource || utmMedium || utmCampaign || utmTerm || utmContent || clickId);

  return {
    utmSource,
    utmMedium,
    utmCampaign,
    utmTerm,
    utmContent,
    clickId,
    clickIdParam,
    platform,
    referrer,
    landingPath,
    hasSignal,
    rawAll: bag,
  };
}

export interface CaptureLandingInput {
  companyId: string;
  contactId: string | null;
  dealId: string | null;
  landingPageId?: string | null;
  raw: unknown; // the client-sent attribution bag (query params + referrer)
}

/**
 * Record a landing/web-form attribution touch + stamp the deal. Gated by
 * `source_attribution`; no-ops when disabled or when there's no UTM/click signal.
 * Fire-safe — swallows all errors so a capture hiccup never fails the submission.
 * Returns true when a lead_sources row was written.
 */
export async function captureLandingAttribution(
  input: CaptureLandingInput
): Promise<boolean> {
  try {
    const parsed = parseAttributionParams(input.raw);
    if (!parsed.hasSignal) return false; // nothing to attribute
    if (!(await isEnabled(input.companyId, "source_attribution"))) return false;

    // Dedup key: one attribution row per created deal (idempotent on a retried
    // submit). NULL when there's no deal — every touch is then recorded as-is.
    const dedupeKey = input.dealId ? `${LANDING_SOURCE}:${input.dealId}` : null;

    await prisma.$executeRawUnsafe(
      `INSERT INTO lead_sources
         ("id","companyId","contactId","dealId","source","leadgenId","campaignId",
          "adsetId","adId","formId","pageId","platform","clickId","utmSource",
          "utmMedium","utmCampaign","captureMethod","landingPageId","dedupeKey",
          "rawJson","createdAt")
       VALUES ($1,$2,$3,$4,$5,NULL,NULL,NULL,NULL,NULL,NULL,$6,$7,$8,$9,$10,
               'auto',$11,$12,$13::jsonb,NOW())
       ON CONFLICT ("companyId","dedupeKey")
         WHERE "leadgenId" IS NULL AND "dedupeKey" IS NOT NULL
         DO NOTHING`,
      randomUUID(),
      input.companyId,
      input.contactId,
      input.dealId,
      LANDING_SOURCE,
      parsed.platform,
      parsed.clickId,
      parsed.utmSource,
      parsed.utmMedium,
      parsed.utmCampaign,
      input.landingPageId ?? null,
      dedupeKey,
      JSON.stringify({
        clickIdParam: parsed.clickIdParam,
        utmTerm: parsed.utmTerm,
        utmContent: parsed.utmContent,
        referrer: parsed.referrer,
        landingPath: parsed.landingPath,
        params: parsed.rawAll,
      })
    );

    // Stamp the deal (auto) — respects manual precedence inside stampAttributionAuto.
    if (input.dealId) {
      await stampAttributionAuto(input.companyId, input.dealId, LANDING_SOURCE);
    }
    return true;
  } catch {
    // Never break the submission on a capture error.
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// CTWA + Messenger referral capture (Sprint 25 Phase D)
// ──────────────────────────────────────────────────────────────────────────
// Click-to-WhatsApp and Click-to-Messenger ads attach a `referral` object to the
// first inbound message. Unlike forms there is no deal at this point — inbound
// just creates a contact/conversation — so we attribute the touch to the contact
// and stamp the contact's most-recent OPEN deal when one exists.
//
// ⚠️ LIVE ACTIVATION GATED ON META CHANNEL APPROVALS (company formation): the
// WhatsApp Cloud / Messenger webhooks only deliver real `referral` payloads once
// the Meta app is approved for those channels. The parsing + capture below is
// complete and unit-safe today; it simply won't fire until the channels go live.

const CTWA_SOURCE = "ctwa_ad";
const MESSENGER_SOURCE = "messenger_ad";

/** Newest open (non-won/lost) deal for a contact — the one a fresh ad chat is about. */
async function findStampableDeal(
  companyId: string,
  contactId: string
): Promise<string | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT "id" FROM deals
      WHERE "companyId" = $1 AND "customerId" = $2 AND "stage" NOT IN ('won','lost')
      ORDER BY "createdAt" DESC LIMIT 1`,
    companyId,
    contactId
  )) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

// Pure parse result of a referral object — no DB, unit-verifiable.
export interface ParsedReferral {
  source: string; // ctwa_ad | messenger_ad
  platform: string; // meta
  clickId: string | null;
  adId: string | null;
  adsetId: string | null;
  campaignId: string | null;
  dedupeSeed: string; // clickId || adId (composed with contactId into the dedupeKey)
  raw: Record<string, unknown>;
}

/**
 * Parse a WhatsApp Cloud inbound message's `referral` object (Click-to-WhatsApp).
 * Returns null unless it's an AD referral carrying an ad id or click id. Pure.
 */
export function parseWhatsAppReferral(msg: unknown): ParsedReferral | null {
  const ref = (msg as { referral?: Record<string, unknown> } | null)?.referral;
  if (!ref || typeof ref !== "object") return null;
  // CTWA referrals are source_type 'ad' (vs 'post'); only ads attribute.
  const sourceType = str(ref["source_type"]);
  if (sourceType && sourceType.toLowerCase() !== "ad") return null;

  const adId = str(ref["source_id"]);
  const clickId = str(ref["ctwa_clid"]);
  if (!adId && !clickId) return null;

  return {
    source: CTWA_SOURCE,
    platform: "meta",
    clickId,
    adId,
    adsetId: null,
    campaignId: null, // CTWA gives the ad id, not the campaign id (resolved later)
    dedupeSeed: clickId || adId || "",
    raw: {
      sourceUrl: str(ref["source_url"]),
      headline: str(ref["headline"]),
      body: str(ref["body"]),
      mediaType: str(ref["media_type"]),
      ctwaClid: clickId,
      sourceId: adId,
    },
  };
}

/**
 * Parse a Messenger/IG messaging event's referral (Click-to-Messenger ad). Rides
 * either `ev.referral` (existing thread) or `ev.postback.referral` (first open
 * from an m.me ad link). Returns null unless source is ADS / an ad id present. Pure.
 */
export function parseMessengerReferral(ev: unknown): ParsedReferral | null {
  const e = ev as
    | { referral?: Record<string, unknown>; postback?: { referral?: Record<string, unknown> } }
    | null;
  const ref = e?.referral ?? e?.postback?.referral;
  if (!ref || typeof ref !== "object") return null;

  const source = str(ref["source"]);
  const adId = str(ref["ad_id"]);
  if (!adId && (!source || source.toUpperCase() !== "ADS")) return null;

  const refParam = str(ref["ref"]);
  const ctx = (ref["ads_context_data"] as Record<string, unknown> | undefined) ?? {};

  return {
    source: MESSENGER_SOURCE,
    platform: "meta",
    clickId: refParam,
    adId,
    adsetId: null,
    campaignId: null,
    dedupeSeed: adId || refParam || "",
    raw: {
      source,
      type: str(ref["type"]),
      ref: refParam,
      adId,
      adTitle: str(ctx["ad_title"]),
      photoUrl: str(ctx["photo_url"]),
      postId: str(ctx["post_id"]),
    },
  };
}

interface ReferralTouch {
  companyId: string;
  contactId: string;
  parsed: ParsedReferral;
}

/** Shared insert + deal stamp for a parsed referral touch. */
async function recordReferralTouch(t: ReferralTouch): Promise<boolean> {
  const { companyId, contactId, parsed } = t;
  const dealId = await findStampableDeal(companyId, contactId);
  const dedupeKey = `${parsed.source}:${parsed.dedupeSeed}:${contactId}`;

  await prisma.$executeRawUnsafe(
    `INSERT INTO lead_sources
       ("id","companyId","contactId","dealId","source","leadgenId","campaignId",
        "adsetId","adId","formId","pageId","platform","clickId","utmSource",
        "utmMedium","utmCampaign","captureMethod","landingPageId","dedupeKey",
        "rawJson","createdAt")
     VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,NULL,NULL,$9,$10,NULL,NULL,NULL,
             'auto',NULL,$11,$12::jsonb,NOW())
     ON CONFLICT ("companyId","dedupeKey")
       WHERE "leadgenId" IS NULL AND "dedupeKey" IS NOT NULL
       DO NOTHING`,
    randomUUID(),
    companyId,
    contactId,
    dealId,
    parsed.source,
    parsed.campaignId,
    parsed.adsetId,
    parsed.adId,
    parsed.platform,
    parsed.clickId,
    dedupeKey,
    JSON.stringify(parsed.raw)
  );

  if (dealId) await stampAttributionAuto(companyId, dealId, parsed.source);
  return true;
}

/**
 * Capture a Click-to-WhatsApp referral from a WhatsApp Cloud inbound message.
 * No-op unless it parses as an ad referral. Gated by source_attribution; fire-safe.
 */
export async function captureWhatsAppReferral(
  companyId: string,
  contactId: string,
  msg: unknown
): Promise<boolean> {
  try {
    const parsed = parseWhatsAppReferral(msg);
    if (!parsed) return false;
    if (!(await isEnabled(companyId, "source_attribution"))) return false;
    return await recordReferralTouch({ companyId, contactId, parsed });
  } catch {
    return false;
  }
}

/**
 * Capture a Click-to-Messenger / IG ad referral from a messaging event. No-op
 * unless it parses as an ad referral. Gated by source_attribution; fire-safe.
 */
export async function captureMessengerReferral(
  companyId: string,
  contactId: string,
  ev: unknown
): Promise<boolean> {
  try {
    const parsed = parseMessengerReferral(ev);
    if (!parsed) return false;
    if (!(await isEnabled(companyId, "source_attribution"))) return false;
    return await recordReferralTouch({ companyId, contactId, parsed });
  } catch {
    return false;
  }
}
