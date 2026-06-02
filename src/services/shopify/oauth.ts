// ============================================================================
// SHOPIFY OAUTH SERVICE (authorization code grant, offline + expiring tokens)
// ----------------------------------------------------------------------------
// Standalone (non-embedded) app flow:
//   1. buildAuthorizeUrl(shop, state) → /admin/oauth/authorize (offline mode:
//      NO grant_options[]; expiring=1 to get a refresh token)
//   2. callback → verifyHmac + state + shop checks
//   3. exchangeCodeForToken(shop, code) → { access_token, refresh_token,
//      expires_in, refresh_token_expires_in, scope }
//   4. refreshAccessToken / getValidAccessToken handle the 1h access-token
//      lifetime via the 90-day rotating refresh token.
//
// Refs (confirmed in recon, Jun 2026):
//   https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
//   https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens
// ============================================================================

import crypto from "crypto";
import { getApiKey, getApiSecret, getScopes, getRedirectUri } from "./config";
import { integrationError } from "../../lib/errors/integrationErrors";

// ──────────────────────────────────────────────────────────────────────
// Shop domain validation (security boundary — we redirect the merchant to
// this host, so a hostile value must never pass).
// ──────────────────────────────────────────────────────────────────────
export function validateShopDomain(input: string): string {
  const normalized = normalizeShopDomain(input);
  if (!normalized) {
    throw integrationError(
      "INVALID_SHOP_DOMAIN",
      `Invalid shop domain: ${String(input).slice(0, 80)}`,
      { shop: String(input).slice(0, 80) }
    );
  }
  return normalized;
}

/**
 * Normalize to "<handle>.myshopify.com" or return null. Accepts bare handle,
 * full domain, or URL form. Only [a-z0-9.-], must end in .myshopify.com.
 */
export function normalizeShopDomain(input: string): string | null {
  if (!input || typeof input !== "string") return null;
  let s = input.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!s) return null;
  if (!s.includes(".")) s = `${s}.myshopify.com`;
  if (!s.endsWith(".myshopify.com")) return null;
  // Reject anything outside the allowed hostname charset.
  if (!/^[a-z0-9.-]+$/.test(s)) return null;
  // Store handle: starts with a letter/digit, then letters/digits/hyphens.
  // Accepts handles with digits + hyphens (e.g. "levana-cosmetics-2",
  // "kgs1qk-h4"). Mirrors the frontend shopIsValid pattern exactly.
  const sub = s.replace(".myshopify.com", "");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(sub)) return null;
  return s;
}

// ──────────────────────────────────────────────────────────────────────
// Authorize URL — offline mode (no grant_options[]=per-user), expiring=1.
// ──────────────────────────────────────────────────────────────────────
export function buildAuthorizeUrl(shop: string, state: string): string {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw integrationError("SHOPIFY_NOT_CONFIGURED", "SHOPIFY_API_KEY not configured");
  }
  const normalized = validateShopDomain(shop);
  const params = new URLSearchParams({
    client_id: apiKey,
    scope: getScopes().join(","),
    redirect_uri: getRedirectUri(),
    state,
    // expiring=1 → Shopify returns an expiring offline token + refresh token,
    // required for new public apps from 2026-04-01. Offline mode = we do NOT
    // send grant_options[]=per-user.
    "expiring": "1",
  });
  return `https://${normalized}/admin/oauth/authorize?${params.toString()}`;
}

// ──────────────────────────────────────────────────────────────────────
// HMAC validation of the callback query string.
//   1. drop hmac (+ signature), keep the rest
//   2. sort "k=v" pairs lexicographically, join with &
//   3. HMAC-SHA256 hex with the API secret
//   4. timing-safe compare to the hmac param
// ──────────────────────────────────────────────────────────────────────
export function verifyHmac(query: Record<string, unknown>): boolean {
  const secret = getApiSecret();
  if (!secret) {
    throw integrationError("SHOPIFY_NOT_CONFIGURED", "SHOPIFY_API_SECRET not configured");
  }
  const provided = typeof query.hmac === "string" ? query.hmac : "";
  if (!provided) return false;

  const message = Object.keys(query)
    .filter((k) => k !== "hmac" && k !== "signature")
    .sort()
    .map((k) => {
      const v = query[k];
      const value = Array.isArray(v) ? v.join(",") : String(v);
      return `${k}=${value}`;
    })
    .join("&");

  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");

  // Lengths must match for timingSafeEqual; bail early if not (still constant
  // work on the common equal-length path).
  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ──────────────────────────────────────────────────────────────────────
// State cookie — signed, short-lived, defense-in-depth alongside the
// oauth_states DB row. Value = "<state>.<hmac>" so a tampered cookie is
// rejected without a DB round-trip.
// ──────────────────────────────────────────────────────────────────────
export const STATE_COOKIE_NAME = "shopify_oauth_state";

export function signState(state: string): string {
  const secret = getApiSecret() ?? "";
  const sig = crypto.createHmac("sha256", secret).update(state).digest("hex");
  return `${state}.${sig}`;
}

export function verifySignedState(cookieValue: string | undefined, expectedState: string): boolean {
  if (!cookieValue) return false;
  const idx = cookieValue.lastIndexOf(".");
  if (idx <= 0) return false;
  const state = cookieValue.slice(0, idx);
  const sig = cookieValue.slice(idx + 1);
  if (state !== expectedState) return false;
  const secret = getApiSecret() ?? "";
  const expected = crypto.createHmac("sha256", secret).update(state).digest("hex");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ──────────────────────────────────────────────────────────────────────
// Token exchange + refresh.
// ──────────────────────────────────────────────────────────────────────
export interface ShopifyTokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresInSec: number | null; // access token lifetime (e.g. 3600)
  refreshTokenExpiresInSec: number | null; // e.g. 7776000 (90d)
  scope: string;
}

const TOKEN_TIMEOUT_MS = 15000;

async function postTokenEndpoint(
  shop: string,
  body: Record<string, string>,
  failCode: "SHOPIFY_CODE_EXCHANGE_FAILED" | "TOKEN_REFRESH_FAILED"
): Promise<ShopifyTokenSet> {
  const normalized = validateShopDomain(shop);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`https://${normalized}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw integrationError("CONNECTION_TIMEOUT", "Shopify token endpoint timed out", {
        shop: normalized,
      });
    }
    throw integrationError(failCode, `Token request failed: ${(err as Error).message}`, {
      shop: normalized,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status === 429) {
      throw integrationError("RATE_LIMITED", "Shopify rate limited the token request", {
        shop: normalized,
      });
    }
    throw integrationError(failCode, `Shopify token endpoint ${response.status}: ${text.slice(0, 200)}`, {
      shop: normalized,
      status: response.status,
    });
  }

  const json = (await response.json()) as Record<string, unknown>;
  const accessToken = typeof json.access_token === "string" ? json.access_token : "";
  if (!accessToken) {
    throw integrationError(failCode, "Shopify token response missing access_token", {
      shop: normalized,
    });
  }
  return {
    accessToken,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : null,
    expiresInSec: typeof json.expires_in === "number" ? json.expires_in : null,
    refreshTokenExpiresInSec:
      typeof json.refresh_token_expires_in === "number" ? json.refresh_token_expires_in : null,
    scope: typeof json.scope === "string" ? json.scope : "",
  };
}

export async function exchangeCodeForToken(shop: string, code: string): Promise<ShopifyTokenSet> {
  const apiKey = getApiKey();
  const apiSecret = getApiSecret();
  if (!apiKey || !apiSecret) {
    throw integrationError("SHOPIFY_NOT_CONFIGURED", "Shopify credentials not configured");
  }
  return postTokenEndpoint(
    shop,
    { client_id: apiKey, client_secret: apiSecret, code },
    "SHOPIFY_CODE_EXCHANGE_FAILED"
  );
}

export async function refreshAccessToken(shop: string, refreshToken: string): Promise<ShopifyTokenSet> {
  const apiKey = getApiKey();
  const apiSecret = getApiSecret();
  if (!apiKey || !apiSecret) {
    throw integrationError("SHOPIFY_NOT_CONFIGURED", "Shopify credentials not configured");
  }
  return postTokenEndpoint(
    shop,
    {
      client_id: apiKey,
      client_secret: apiSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    },
    "TOKEN_REFRESH_FAILED"
  );
}

// ──────────────────────────────────────────────────────────────────────
// Scope verification — merchant can tamper with the scope param, so confirm
// the granted scopes are a superset of what we require.
// ──────────────────────────────────────────────────────────────────────
export function grantedScopesSatisfy(grantedScope: string): boolean {
  const granted = new Set(
    grantedScope
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  return getScopes().every((required) => granted.has(required));
}
