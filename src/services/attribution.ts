// ============================================================================
// SOURCE ATTRIBUTION (Sprint 25) — canonical source vocabulary + helpers.
// ----------------------------------------------------------------------------
// Shared by manual tagging (Phase B), landing-UTM auto-capture (Phase C), CTWA /
// Messenger referral capture (Phase D), and lead-ad backfill + rollup wiring
// (Phase E). One place so the deal stamp, the lead_sources ledger, and the
// campaign-economics rollup all speak the same tokens.
//
// A deal's attribution lives in TWO thin raw columns (NOT in the Prisma model;
// set/read via raw SQL exactly like deals.adCampaignId):
//   deals.attributionSource        — one of ATTRIBUTION_SOURCES below
//   deals.attributionCaptureMethod — 'auto' | 'manual'
// lead_sources stays the rich per-touch audit ledger; these columns are the fast
// read model.
// ============================================================================

// The canonical set of source tokens. Auto-capture writes the integration-specific
// tokens (meta_lead_ad / google_ads_lead / ctwa_ad / messenger_ad / landing_utm);
// the manual dropdown additionally offers the bare-platform + offline channels for
// the platforms with no lead-capture plumbing (tiktok/snapchat/x/linkedin) and
// organic/referral/other.
export const ATTRIBUTION_SOURCES = [
  // Auto-captured (integration-specific tokens)
  "meta_lead_ad", // Meta Instant Form lead ad
  "ctwa_ad", // Click-to-WhatsApp ad (Phase D)
  "messenger_ad", // Click-to-Messenger ad (Phase D)
  "google_ads_lead", // Google lead form
  "landing_utm", // Website / landing page with UTM/click id (Phase C)
  // Manual-friendly platform/channel tokens
  "meta", // Facebook / Instagram (manual)
  "google", // Google / YouTube (manual)
  "tiktok",
  "snapchat",
  "twitter", // X / Twitter
  "linkedin",
  "organic", // organic / direct / SEO
  "referral", // word of mouth / partner
  "other",
] as const;
export type AttributionSource = (typeof ATTRIBUTION_SOURCES)[number];

const SOURCE_SET = new Set<string>(ATTRIBUTION_SOURCES);

/** Validate/normalize an arbitrary string to a known source token, else null. */
export function coerceSource(v: unknown): AttributionSource | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return SOURCE_SET.has(s) ? (s as AttributionSource) : null;
}

export type CaptureMethod = "auto" | "manual";

export function coerceCaptureMethod(v: unknown): CaptureMethod {
  return v === "manual" ? "manual" : "auto";
}

// The manual dropdown's offered options (a curated subset of the vocabulary —
// integration-only tokens like meta_lead_ad are produced by auto-capture, not
// hand-picked). The frontend renders trilingual labels keyed by these values.
export const MANUAL_SOURCE_OPTIONS: AttributionSource[] = [
  "meta",
  "ctwa_ad",
  "messenger_ad",
  "google",
  "landing_utm",
  "tiktok",
  "snapchat",
  "twitter",
  "linkedin",
  "organic",
  "referral",
  "other",
];

// Map a source token → the unified ad platform it rolls up to (for campaign
// economics, Phase E). Returns null for non-ad channels (organic/referral/other)
// and for tokens that only attribute via the explicit deals.adCampaignId tag.
export function platformForSource(source: string): string | null {
  switch (source) {
    case "meta_lead_ad":
    case "ctwa_ad":
    case "messenger_ad":
    case "meta":
      return "meta";
    case "google_ads_lead":
    case "google":
      return "google";
    case "tiktok":
      return "tiktok";
    case "snapchat":
      return "snapchat";
    case "twitter":
      return "twitter";
    case "linkedin":
      return "linkedin";
    default:
      return null; // landing_utm (platform resolved from utm/click id), organic, referral, other
  }
}
