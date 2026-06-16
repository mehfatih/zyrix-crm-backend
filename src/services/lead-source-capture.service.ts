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
