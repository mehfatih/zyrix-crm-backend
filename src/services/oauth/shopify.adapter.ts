// ============================================================================
// SHOPIFY OAUTH ADAPTER
// ----------------------------------------------------------------------------
// Shopify's OAuth is simpler than Salla's: each shop has its own domain
// (e.g. my-store.myshopify.com) so the authorize URL is per-shop, not
// global. Tokens are permanent (no refresh flow) — merchants revoke
// access by uninstalling the app from their admin.
//
// Docs: https://shopify.dev/docs/apps/auth/oauth/getting-started
// Authorize: https://{shop}.myshopify.com/admin/oauth/authorize
// Token:     https://{shop}.myshopify.com/admin/oauth/access_token
// Shop info: GET https://{shop}.myshopify.com/admin/api/2024-10/shop.json
// ============================================================================

import { env } from "../../config/env";

const SCOPES = [
  "read_customers",
  "write_customers",
  "read_orders",
  "read_products",
];

export interface ShopifyTokenResponse {
  accessToken: string;
  scope: string;
}

export interface ShopifyShopInfo {
  id: number;
  name: string;
  domain: string;
  currency: string | null;
  email: string | null;
  countryName: string | null;
}

export function isShopifyConfigured(): boolean {
  return Boolean(env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET);
}

/**
 * Normalize a shop identifier. Accepts:
 *   - 'my-store'
 *   - 'my-store.myshopify.com'
 *   - 'https://my-store.myshopify.com'
 *   - 'https://my-store.myshopify.com/'
 * Returns just 'my-store.myshopify.com' or null if the input is malformed.
 *
 * This is a security boundary — we send the merchant to this URL as
 * part of OAuth, so validating the format prevents a hostile input from
 * redirecting to an attacker-controlled host.
 */
export function normalizeShopDomain(input: string): string | null {
  if (!input || typeof input !== "string") return null;
  let s = input.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!s) return null;
  // If the caller gave us just 'my-store', append .myshopify.com
  if (!s.includes(".")) s = `${s}.myshopify.com`;
  // Must end with .myshopify.com — reject everything else
  if (!s.endsWith(".myshopify.com")) return null;
  // Subdomain validation: alphanumeric + hyphens, 3+ chars, no leading/trailing hyphen
  const sub = s.replace(".myshopify.com", "");
  if (!/^[a-z0-9][a-z0-9-]{1,60}[a-z0-9]$/.test(sub)) return null;
  return s;
}

export function buildInstallUrl(shopDomain: string, state: string): string {
  if (!env.SHOPIFY_CLIENT_ID) {
    throw new Error("SHOPIFY_CLIENT_ID is not configured");
  }
  const normalized = normalizeShopDomain(shopDomain);
  if (!normalized) {
    throw new Error("Invalid shop domain");
  }
  const params = new URLSearchParams({
    client_id: env.SHOPIFY_CLIENT_ID,
    scope: SCOPES.join(","),
    redirect_uri: `${env.API_URL}/api/oauth/shopify/callback`,
    state,
    // Force the consent screen even for returning users so they see
    // the latest scope set.
    "grant_options[]": "per-user",
  });
  return `https://${normalized}/admin/oauth/authorize?${params.toString()}`;
}

export async function exchangeCode(
  shopDomain: string,
  code: string
): Promise<ShopifyTokenResponse> {
  if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) {
    throw new Error("Shopify client credentials are not configured");
  }
  const normalized = normalizeShopDomain(shopDomain);
  if (!normalized) {
    throw new Error("Invalid shop domain");
  }

  const response = await fetch(
    `https://${normalized}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: env.SHOPIFY_CLIENT_ID,
        client_secret: env.SHOPIFY_CLIENT_SECRET,
        code,
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Shopify token exchange failed (${response.status}): ${text.slice(0, 200)}`
    );
  }
  const json = (await response.json()) as any;
  return {
    accessToken: json.access_token,
    scope: json.scope ?? "",
  };
}

export async function fetchShopInfo(
  shopDomain: string,
  accessToken: string
): Promise<ShopifyShopInfo> {
  const normalized = normalizeShopDomain(shopDomain);
  if (!normalized) {
    throw new Error("Invalid shop domain");
  }
  const response = await fetch(
    `https://${normalized}/admin/api/2024-10/shop.json`,
    {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        Accept: "application/json",
      },
    }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Shopify shop info fetch failed (${response.status}): ${text.slice(0, 200)}`
    );
  }
  const json = (await response.json()) as any;
  const shop = json.shop ?? {};
  return {
    id: shop.id,
    name: shop.name ?? "Shopify store",
    domain: shop.myshopify_domain ?? normalized,
    currency: shop.currency ?? null,
    email: shop.email ?? null,
    countryName: shop.country_name ?? null,
  };
}
