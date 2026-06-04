// ============================================================================
// GOOGLE OAUTH 2.0 (authorization-code grant, offline access) — Sprint 5
// ----------------------------------------------------------------------------
// Stateless helpers around the googleapis OAuth2 client:
//   1. buildAuthorizeUrl(state) → Google consent screen URL (offline +
//      prompt=consent so we always get a refresh token; drive.file scope only)
//   2. exchangeCodeForTokens(code) → { accessToken, refreshToken, expiryDate,
//      scope }
//   3. fetchProfileEmail(accessToken) → the connected Google account email
//   4. refreshAccessToken(refreshToken) → rotated access token + expiry
//   5. revokeToken(token) → best-effort remote revoke on disconnect
// Persistence + the authorized client live in connections.service.ts.
// ============================================================================

import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { getClientId, getClientSecret, getRedirectUri, GOOGLE_SCOPES } from "./config";
import { integrationError } from "../../lib/errors/integrationErrors";

/** Construct a fresh OAuth2 client bound to our integration credentials. */
export function createOAuth2Client(): OAuth2Client {
  const clientId = getClientId();
  const clientSecret = getClientSecret();
  if (!clientId || !clientSecret) {
    throw integrationError(
      "GOOGLE_NOT_CONFIGURED",
      "Google integration OAuth credentials are not configured",
      { platform: "google" }
    );
  }
  return new google.auth.OAuth2(clientId, clientSecret, getRedirectUri());
}

/**
 * Build the Google consent screen URL.
 *  • access_type=offline  → returns a refresh token
 *  • prompt=consent       → forces the consent screen so a refresh token is
 *    re-issued even on re-connect (Google omits it on silent re-auth otherwise)
 *  • include_granted_scopes=true → incremental auth friendliness
 */
export function buildAuthorizeUrl(state: string): string {
  const client = createOAuth2Client();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GOOGLE_SCOPES,
    include_granted_scopes: true,
    state,
  });
}

export interface GoogleTokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiryDate: Date | null; // absolute expiry timestamp
  scope: string;
}

/** Exchange the one-time auth code for tokens. */
export async function exchangeCodeForTokens(code: string): Promise<GoogleTokenSet> {
  const client = createOAuth2Client();
  try {
    const { tokens } = await client.getToken(code);
    if (!tokens.access_token) {
      throw integrationError(
        "GOOGLE_CODE_EXCHANGE_FAILED",
        "Google token response missing access_token",
        { platform: "google" }
      );
    }
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      scope: tokens.scope ?? GOOGLE_SCOPES.join(" "),
    };
  } catch (err) {
    if ((err as { code?: string }).code === "GOOGLE_CODE_EXCHANGE_FAILED") throw err;
    throw integrationError(
      "GOOGLE_CODE_EXCHANGE_FAILED",
      `Google code exchange failed: ${(err as Error).message}`,
      { platform: "google" }
    );
  }
}

/** Refresh an access token using the stored refresh token. */
export async function refreshAccessToken(refreshToken: string): Promise<GoogleTokenSet> {
  const client = createOAuth2Client();
  client.setCredentials({ refresh_token: refreshToken });
  try {
    const { credentials } = await client.refreshAccessToken();
    if (!credentials.access_token) {
      throw integrationError("TOKEN_REFRESH_FAILED", "Google refresh returned no access_token", {
        platform: "google",
      });
    }
    return {
      accessToken: credentials.access_token,
      // Google does not rotate the refresh token here — keep the existing one.
      refreshToken: credentials.refresh_token ?? null,
      expiryDate: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
      scope: credentials.scope ?? "",
    };
  } catch (err) {
    if ((err as { code?: string }).code === "TOKEN_REFRESH_FAILED") throw err;
    throw integrationError(
      "TOKEN_REFRESH_FAILED",
      `Google token refresh failed: ${(err as Error).message}`,
      { platform: "google" }
    );
  }
}

/** Fetch the connected account's email (identity for the UI badge). */
export async function fetchProfileEmail(accessToken: string): Promise<string> {
  const client = createOAuth2Client();
  client.setCredentials({ access_token: accessToken });
  try {
    const oauth2 = google.oauth2({ version: "v2", auth: client });
    const { data } = await oauth2.userinfo.get();
    return data.email ?? "";
  } catch (err) {
    throw integrationError(
      "GOOGLE_API_FAILED",
      `Failed to fetch Google profile: ${(err as Error).message}`,
      { platform: "google" }
    );
  }
}

/** Best-effort remote token revocation on disconnect. Never throws. */
export async function revokeToken(token: string): Promise<void> {
  try {
    const client = createOAuth2Client();
    await client.revokeToken(token);
  } catch {
    // Non-fatal — the merchant can also revoke from their Google account.
  }
}
