// ============================================================================
// META LEAD ADS — CONFIG RESOLVER
// ----------------------------------------------------------------------------
// Single source of truth for the Lead Ads module. Reuses the SAME Meta app as
// WhatsApp: the X-Hub-Signature-256 is verified with META_APP_SECRET (shared,
// app-level). The Page access token used to fetch a lead's PII can come from
// the env (single-Page MVP) OR be stored per-Page sealed in meta_lead_pages.
//
// Every getter reads env lazily at call time — nothing throws at import, so the
// server boots fine with all Meta creds missing.
// ============================================================================

import { env } from "../../config/env";

export function getAppSecret(): string | undefined {
  return env.META_APP_SECRET;
}
export function getVerifyToken(): string | undefined {
  return env.META_WEBHOOK_VERIFY_TOKEN;
}
/** Env-level default Page token (single-Page MVP). Per-Page tokens override. */
export function getDefaultPageToken(): string | undefined {
  return env.META_LEADS_PAGE_ACCESS_TOKEN;
}
export function getGraphVersion(): string {
  return env.META_GRAPH_API_VERSION;
}

/** Generic Graph API URL builder, e.g. graphUrl(`${leadgenId}`). */
export function graphUrl(path: string): string {
  return `https://graph.facebook.com/${getGraphVersion()}/${path}`;
}

/** Inbound webhook needs the app secret + verify token. */
export function isWebhookConfigured(): boolean {
  return Boolean(getAppSecret() && getVerifyToken());
}

/**
 * Lead retrieval needs a Page token. True when at least the env-level default
 * token is present; a per-Page sealed token (meta_lead_pages) also satisfies
 * this at fetch time even if the env default is absent.
 */
export function isLeadsConfigured(): boolean {
  return Boolean(getAppSecret() && getDefaultPageToken());
}
