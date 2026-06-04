// ============================================================================
// GOOGLE WORKSPACE CONFIG RESOLVER (Drive + Sheets) — Sprint 5
// ----------------------------------------------------------------------------
// Single source of truth for the Google INTEGRATION OAuth client. This is a
// SEPARATE Google Cloud OAuth client from the login one (GOOGLE_CLIENT_ID), so
// merchant Sign-In is never at risk.
//
// SCOPE POLICY (critical): we request ONLY the non-sensitive `drive.file`
// scope (+ openid email profile for identity). `drive.file` needs NO Google
// verification, can publish to Production day one, and only grants access to
// files our app created or the user explicitly picked. NEVER add a
// sensitive/restricted scope (drive, drive.readonly, spreadsheets, …).
// ============================================================================

import { env } from "../../config/env";
import { isTokenCipherConfigured } from "../../lib/crypto/tokenCipher";

// The ONLY scopes we ever request. drive.file is non-sensitive; the Sheets API
// works against files our app created or the user picked under this grant.
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive.file",
];

export function getClientId(): string | undefined {
  return env.GOOGLE_INTEGRATION_CLIENT_ID;
}

export function getClientSecret(): string | undefined {
  return env.GOOGLE_INTEGRATION_CLIENT_SECRET;
}

/**
 * The redirect URI registered in the Google Cloud OAuth client. Prefer the
 * explicit env var; otherwise derive from API_URL so local/dev still works.
 */
export function getRedirectUri(): string {
  if (env.GOOGLE_INTEGRATION_REDIRECT_URI) {
    return env.GOOGLE_INTEGRATION_REDIRECT_URI;
  }
  return `${env.API_URL.replace(/\/$/, "")}/api/integrations/google/callback`;
}

/** Web app base URL for the success/error return redirect. */
export function getWebAppUrl(): string {
  return env.FRONTEND_URL.replace(/\/$/, "");
}

/**
 * Google integration is "configured" only when client id + secret AND the
 * token encryption key are present — we refuse to start an OAuth flow we can't
 * securely complete (tokens must be encryptable at rest).
 */
export function isGoogleConfigured(): boolean {
  return Boolean(getClientId() && getClientSecret() && isTokenCipherConfigured());
}
