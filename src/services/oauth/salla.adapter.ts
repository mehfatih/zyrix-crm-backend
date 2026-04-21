// ============================================================================
// SALLA OAUTH ADAPTER
// ----------------------------------------------------------------------------
// Handles the Salla OAuth install flow:
//   • buildInstallUrl(state) — constructs the Salla consent URL
//   • exchangeCode(code) → access token + refresh token + store info
//   • fetchStoreInfo(accessToken) → shop domain + name + currency
//   • refreshToken(refreshToken) → new access/refresh tokens
//
// Salla's OAuth spec: https://docs.salla.dev/docs/saas/Tjg4OTc0MTQ-authorization
// Authorize URL: https://accounts.salla.sa/oauth2/auth
// Token URL:     https://accounts.salla.sa/oauth2/token
// Store info:    GET https://api.salla.dev/admin/v2/store/info
// ============================================================================

import { env } from "../../config/env";

const AUTHORIZE_URL = "https://accounts.salla.sa/oauth2/auth";
const TOKEN_URL = "https://accounts.salla.sa/oauth2/token";
const STORE_INFO_URL = "https://api.salla.dev/admin/v2/store/info";

const SCOPES = [
  "offline_access",
  "customers.read",
  "customers.write",
  "orders.read",
  "products.read",
  "webhooks.read_write",
];

export interface SallaTokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  tokenType: string;
  scope: string;
}

export interface SallaStoreInfo {
  id: number | string;
  name: string;
  domain: string;
  currency: string | null;
  email: string | null;
}

export function isSallaConfigured(): boolean {
  return Boolean(env.SALLA_CLIENT_ID && env.SALLA_CLIENT_SECRET);
}

export function buildInstallUrl(state: string): string {
  if (!env.SALLA_CLIENT_ID) {
    throw new Error("SALLA_CLIENT_ID is not configured");
  }
  const params = new URLSearchParams({
    client_id: env.SALLA_CLIENT_ID,
    redirect_uri: `${env.API_URL}/api/oauth/salla/callback`,
    response_type: "code",
    scope: SCOPES.join(" "),
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeCode(code: string): Promise<SallaTokenResponse> {
  if (!env.SALLA_CLIENT_ID || !env.SALLA_CLIENT_SECRET) {
    throw new Error("Salla client credentials are not configured");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: env.SALLA_CLIENT_ID,
    client_secret: env.SALLA_CLIENT_SECRET,
    redirect_uri: `${env.API_URL}/api/oauth/salla/callback`,
    scope: SCOPES.join(" "),
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Salla token exchange failed (${response.status}): ${text.slice(0, 200)}`
    );
  }
  const json = (await response.json()) as any;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresIn: json.expires_in ?? 3600,
    tokenType: json.token_type ?? "Bearer",
    scope: json.scope ?? "",
  };
}

export async function fetchStoreInfo(
  accessToken: string
): Promise<SallaStoreInfo> {
  const response = await fetch(STORE_INFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Salla store info fetch failed (${response.status}): ${text.slice(0, 200)}`
    );
  }
  const json = (await response.json()) as any;
  const data = json.data ?? json;
  return {
    id: data.id ?? "",
    name: data.name ?? data.title ?? "Salla store",
    domain: data.domain ?? data.url ?? "",
    currency: data.currency ?? data.base_currency ?? null,
    email: data.email ?? null,
  };
}

export async function refreshToken(
  refreshToken: string
): Promise<SallaTokenResponse> {
  if (!env.SALLA_CLIENT_ID || !env.SALLA_CLIENT_SECRET) {
    throw new Error("Salla client credentials are not configured");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: env.SALLA_CLIENT_ID,
    client_secret: env.SALLA_CLIENT_SECRET,
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Salla token refresh failed (${response.status}): ${text.slice(0, 200)}`
    );
  }
  const json = (await response.json()) as any;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? refreshToken,
    expiresIn: json.expires_in ?? 3600,
    tokenType: json.token_type ?? "Bearer",
    scope: json.scope ?? "",
  };
}
