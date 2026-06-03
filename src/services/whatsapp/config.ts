// ============================================================================
// WHATSAPP CONFIG RESOLVER
// ----------------------------------------------------------------------------
// Single source of truth for WhatsApp Cloud API config. The access token is a
// single-WABA System User token kept as a Railway secret (env), so there's no
// per-tenant token-at-rest to encrypt here — tokenCipher is reserved for a
// future multi-WABA model where tokens would live in the DB.
// ============================================================================

import { env } from "../../config/env";

export function getAppSecret(): string | undefined {
  return env.META_APP_SECRET;
}
export function getVerifyToken(): string | undefined {
  return env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
}
export function getAccessToken(): string | undefined {
  return env.WHATSAPP_ACCESS_TOKEN;
}
export function getPhoneNumberId(): string | undefined {
  return env.WHATSAPP_PHONE_NUMBER_ID;
}
export function getWabaId(): string | undefined {
  return env.WHATSAPP_WABA_ID;
}
export function getGraphVersion(): string {
  return env.WHATSAPP_GRAPH_API_VERSION;
}

/** Cloud API send endpoint for the configured phone number. */
export function graphMessagesUrl(): string {
  return `https://graph.facebook.com/${getGraphVersion()}/${getPhoneNumberId()}/messages`;
}

/** Generic Graph API URL builder, e.g. `${WABA_ID}/message_templates`. */
export function graphUrl(path: string): string {
  return `https://graph.facebook.com/${getGraphVersion()}/${path}`;
}

/**
 * Inbound (webhook) only needs the app secret + verify token. Outbound also
 * needs the phone number id + access token.
 */
export function isWebhookConfigured(): boolean {
  return Boolean(getAppSecret() && getVerifyToken());
}
export function isWhatsAppConfigured(): boolean {
  return Boolean(getAppSecret() && getAccessToken() && getPhoneNumberId());
}
