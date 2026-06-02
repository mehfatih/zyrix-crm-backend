// ============================================================================
// SHOPIFY CONFIG RESOLVER
// ----------------------------------------------------------------------------
// Single source of truth for Shopify OAuth config in the new integrations
// module. Reads the sprint-named env vars but falls back to the legacy
// SHOPIFY_CLIENT_ID/SECRET so either set works (backward compatibility), per
// the recon decision.
// ============================================================================

import { env } from "../../config/env";
import { isTokenCipherConfigured } from "../../lib/crypto/tokenCipher";

export function getApiKey(): string | undefined {
  return env.SHOPIFY_API_KEY ?? env.SHOPIFY_CLIENT_ID;
}

export function getApiSecret(): string | undefined {
  return env.SHOPIFY_API_SECRET ?? env.SHOPIFY_CLIENT_SECRET;
}

export function getScopes(): string[] {
  return env.SHOPIFY_SCOPES.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function getApiVersion(): string {
  return env.SHOPIFY_API_VERSION;
}

/**
 * The redirect URI registered in the Partner Dashboard. Prefer the explicit
 * env var; otherwise derive it from API_URL so local/dev still works.
 */
export function getRedirectUri(): string {
  if (env.SHOPIFY_REDIRECT_URI) return env.SHOPIFY_REDIRECT_URI;
  return `${env.API_URL.replace(/\/$/, "")}/api/integrations/shopify/callback`;
}

/** Web app base URL for the success/error return redirect. */
export function getWebAppUrl(): string {
  return (env.SHOPIFY_APP_URL ?? env.FRONTEND_URL).replace(/\/$/, "");
}

/** Mobile deep-link scheme, normalized to end with "://". */
export function getMobileScheme(): string {
  const raw = env.MOBILE_DEEP_LINK_SCHEME || "zyrix://";
  return raw.endsWith("://") ? raw : `${raw}://`;
}

/**
 * Shopify is "configured" only when key + secret AND the token encryption
 * key are present — we refuse to start an OAuth flow we can't securely
 * complete (tokens must be encryptable at rest).
 */
export function isShopifyConfigured(): boolean {
  return Boolean(getApiKey() && getApiSecret() && isTokenCipherConfigured());
}
