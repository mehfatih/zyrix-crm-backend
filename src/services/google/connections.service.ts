// ============================================================================
// GOOGLE CONNECTIONS SERVICE — Sprint 5
// ----------------------------------------------------------------------------
// Persistence + token lifecycle for google_connections (one row per company).
// Tokens are AES-256-GCM encrypted at rest via tokenCipher; the SealedToken is
// JSON-serialized into the single accessToken/refreshToken TEXT columns. Raw
// SQL ($queryRawUnsafe/$executeRawUnsafe) mirrors the oauth_states /
// shopify_connections pattern and stays independent of the Prisma client.
// ============================================================================

import { randomUUID } from "crypto";
import type { OAuth2Client } from "google-auth-library";
import { prisma } from "../../config/database";
import {
  encryptToken,
  decryptToken,
  type SealedToken,
} from "../../lib/crypto/tokenCipher";
import { integrationError } from "../../lib/errors/integrationErrors";
import { recordIntegrationEvent } from "../integration-events.service";
import {
  createOAuth2Client,
  refreshAccessToken,
  revokeToken,
  type GoogleTokenSet,
} from "./oauth";

export type GoogleConnectionStatus = "active" | "revoked";

export interface GoogleConnectionRow {
  id: string;
  companyId: string;
  googleEmail: string;
  accessToken: string; // JSON SealedToken
  refreshToken: string; // JSON SealedToken
  scope: string;
  expiryDate: Date | null;
  driveFolderId: string | null;
  status: GoogleConnectionStatus;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT_COLS = `
  "id", "companyId", "googleEmail", "accessToken", "refreshToken",
  "scope", "expiryDate", "driveFolderId", "status", "createdAt", "updatedAt"
`;

// ── Sealed-token (de)serialization into a single TEXT column ───────────────
function seal(plaintext: string): string {
  return JSON.stringify(encryptToken(plaintext));
}
function unseal(text: string): string {
  return decryptToken(JSON.parse(text) as SealedToken);
}

export async function getConnection(
  companyId: string
): Promise<GoogleConnectionRow | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT ${SELECT_COLS} FROM google_connections WHERE "companyId" = $1 LIMIT 1`,
    companyId
  )) as GoogleConnectionRow[];
  return rows[0] ?? null;
}

/**
 * Insert or update the company's Google connection with a fresh token set.
 * Encrypts both tokens. If a refresh token is absent on re-connect (Google
 * omits it on silent re-auth), the existing one is preserved.
 */
export async function upsertConnection(params: {
  companyId: string;
  googleEmail: string;
  tokens: GoogleTokenSet;
}): Promise<string> {
  const { companyId, googleEmail, tokens } = params;
  const existing = await getConnection(companyId);

  const accessSealed = seal(tokens.accessToken);
  const refreshSealed = tokens.refreshToken
    ? seal(tokens.refreshToken)
    : existing?.refreshToken ?? null;

  if (!refreshSealed) {
    throw integrationError(
      "GOOGLE_AUTH_FAILED",
      "No refresh token returned by Google and none on file — reconnect required",
      { companyId, platform: "google" }
    );
  }

  if (existing) {
    await prisma.$executeRawUnsafe(
      `UPDATE google_connections SET
         "googleEmail" = $1, "accessToken" = $2, "refreshToken" = $3,
         "scope" = $4, "expiryDate" = $5, "status" = 'active', "updatedAt" = NOW()
       WHERE "companyId" = $6`,
      googleEmail,
      accessSealed,
      refreshSealed,
      tokens.scope,
      tokens.expiryDate,
      companyId
    );
    return existing.id;
  }

  const id = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO google_connections (
       "id", "companyId", "googleEmail", "accessToken", "refreshToken",
       "scope", "expiryDate", "status", "createdAt", "updatedAt"
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,'active',NOW(),NOW())`,
    id,
    companyId,
    googleEmail,
    accessSealed,
    refreshSealed,
    tokens.scope,
    tokens.expiryDate
  );
  return id;
}

/** Persist a rotated access token (after a refresh). */
async function persistRotatedAccess(
  companyId: string,
  accessToken: string,
  expiryDate: Date | null
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE google_connections SET "accessToken" = $1, "expiryDate" = $2, "updatedAt" = NOW() WHERE "companyId" = $3`,
    seal(accessToken),
    expiryDate,
    companyId
  );
}

export async function setDriveFolderId(
  companyId: string,
  driveFolderId: string
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE google_connections SET "driveFolderId" = $1, "updatedAt" = NOW() WHERE "companyId" = $2`,
    driveFolderId,
    companyId
  );
}

export async function setStatus(
  companyId: string,
  status: GoogleConnectionStatus
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE google_connections SET "status" = $1, "updatedAt" = NOW() WHERE "companyId" = $2`,
    status,
    companyId
  );
}

export async function deleteConnection(companyId: string): Promise<void> {
  inflightRefresh.delete(companyId);
  await prisma.$executeRawUnsafe(
    `DELETE FROM google_connections WHERE "companyId" = $1`,
    companyId
  );
}

/**
 * Best-effort remote revoke at Google, then delete the local row. Returns true
 * if a connection existed. Never throws on the remote-revoke leg.
 */
export async function disconnectConnection(companyId: string): Promise<boolean> {
  const conn = await getConnection(companyId);
  if (!conn) return false;
  try {
    await revokeToken(unseal(conn.accessToken));
  } catch {
    // Non-fatal — local delete proceeds regardless.
  }
  await deleteConnection(companyId);
  return true;
}

// Refresh when within this window of expiry (or already expired).
const REFRESH_SKEW_MS = 2 * 60 * 1000; // 2 minutes

// Single-flight: one in-flight refresh per company so concurrent operations
// don't each hit Google's token endpoint.
const inflightRefresh = new Map<string, Promise<GoogleTokenSet>>();

async function refreshSingleFlight(
  companyId: string,
  refreshToken: string
): Promise<GoogleTokenSet> {
  const existing = inflightRefresh.get(companyId);
  if (existing) return existing;
  const p = refreshAccessToken(refreshToken).finally(() =>
    inflightRefresh.delete(companyId)
  );
  inflightRefresh.set(companyId, p);
  return p;
}

/**
 * Return an authorized googleapis OAuth2 client for the company, refreshing +
 * persisting the access token if it's expired/near-expiry. Throws
 * GOOGLE_NOT_CONNECTED if there is no active connection or the refresh token is
 * no longer valid (merchant revoked access) — the UI then prompts a reconnect.
 */
export async function getGoogleClient(companyId: string): Promise<OAuth2Client> {
  const conn = await getConnection(companyId);
  if (!conn || conn.status !== "active") {
    throw integrationError("GOOGLE_NOT_CONNECTED", "Google is not connected for this company", {
      companyId,
      platform: "google",
    });
  }

  const refreshToken = unseal(conn.refreshToken);
  let accessToken = unseal(conn.accessToken);
  let expiryDate = conn.expiryDate;

  const expired =
    expiryDate != null && expiryDate.getTime() - Date.now() <= REFRESH_SKEW_MS;

  if (expired) {
    try {
      const rotated = await refreshSingleFlight(companyId, refreshToken);
      accessToken = rotated.accessToken;
      expiryDate = rotated.expiryDate;
      await persistRotatedAccess(companyId, accessToken, expiryDate);
      await recordIntegrationEvent({
        companyId,
        platform: "google",
        eventType: "token_refresh",
        requestContext: { connectionId: conn.id },
      });
    } catch (err) {
      // invalid_grant ⇒ merchant revoked; mark revoked so the UI reconnects.
      await setStatus(companyId, "revoked");
      await recordIntegrationEvent({
        companyId,
        platform: "google",
        eventType: "token_refresh_failure",
        errorCode: "TOKEN_REFRESH_FAILED",
        errorMessage: (err as Error).message,
        requestContext: { connectionId: conn.id },
      });
      throw integrationError(
        "GOOGLE_NOT_CONNECTED",
        "Google access expired and could not be refreshed — reconnect required",
        { companyId, platform: "google" }
      );
    }
  }

  const client = createOAuth2Client();
  client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
    expiry_date: expiryDate ? expiryDate.getTime() : undefined,
  });

  // Defense-in-depth: if googleapis refreshes mid-call, persist the new token.
  client.on("tokens", (tokens) => {
    if (tokens.access_token) {
      void persistRotatedAccess(
        companyId,
        tokens.access_token,
        tokens.expiry_date ? new Date(tokens.expiry_date) : null
      ).catch((e) => console.error("[google] persist rotated token failed:", e));
    }
  });

  return client;
}
