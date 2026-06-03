// ============================================================================
// META MESSAGING — CONFIG RESOLVER (Messenger + Instagram DM)
// ----------------------------------------------------------------------------
// Same Meta app as WhatsApp + Lead Ads. Signature uses the shared
// META_APP_SECRET; the GET handshake uses the shared META_WEBHOOK_VERIFY_TOKEN.
// The Page access token (messaging scopes) can be its own var or fall back to
// the Sprint-2 leads Page token if that System-User token is scoped for both.
//
// Every getter reads env lazily — nothing throws at import, so the server boots
// fine with all Meta creds missing.
// ============================================================================

import { env } from "../../config/env";

export function getAppSecret(): string | undefined {
  return env.META_APP_SECRET;
}
export function getVerifyToken(): string | undefined {
  return env.META_WEBHOOK_VERIFY_TOKEN;
}
export function getGraphVersion(): string {
  return env.META_GRAPH_API_VERSION;
}
/** Page token w/ messaging scopes; falls back to the leads Page token. */
export function getPageToken(): string | undefined {
  return env.META_PAGE_ACCESS_TOKEN ?? env.META_LEADS_PAGE_ACCESS_TOKEN;
}
export function getPageId(): string | undefined {
  return env.META_PAGE_ID;
}
export function getInstagramAccountId(): string | undefined {
  return env.INSTAGRAM_ACCOUNT_ID;
}

/** Send endpoint: POST {PAGE_ID}/messages handles Messenger AND IG (via Page). */
export function graphSendUrl(): string {
  return `https://graph.facebook.com/${getGraphVersion()}/${getPageId()}/messages`;
}
export function graphUrl(path: string): string {
  return `https://graph.facebook.com/${getGraphVersion()}/${path}`;
}

/** Inbound webhook needs the app secret + verify token (shared). */
export function isWebhookConfigured(): boolean {
  return Boolean(getAppSecret() && getVerifyToken());
}
/** Outbound needs a Page token + Page id. */
export function isMessagingConfigured(): boolean {
  return Boolean(getPageToken() && getPageId());
}
