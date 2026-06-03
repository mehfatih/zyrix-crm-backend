// ============================================================================
// SHOPIFY CONNECTIONS SERVICE
// ----------------------------------------------------------------------------
// Persistence + token lifecycle for shopify_connections. Tokens are AES-256-GCM
// encrypted at rest; raw values never hit the DB or logs. Uses raw SQL
// ($queryRawUnsafe/$executeRawUnsafe) to match the existing oauth_states
// pattern and stay independent of the generated Prisma client.
// ============================================================================

import { randomUUID } from "crypto";
import { prisma } from "../../config/database";
import { encryptToken, decryptToken } from "../../lib/crypto/tokenCipher";
import { integrationError } from "../../lib/errors/integrationErrors";
import { refreshAccessToken, type ShopifyTokenSet } from "./oauth";
import { recordIntegrationEvent } from "../integration-events.service";

export type ConnectionStatus =
  | "pending"
  | "connected"
  | "needs_reauth"
  | "revoked"
  | "error";

export interface ShopifyConnectionRow {
  id: string;
  companyId: string;
  shopDomain: string;
  status: ConnectionStatus;
  accessTokenCiphertext: string | null;
  accessTokenIv: string | null;
  accessTokenTag: string | null;
  refreshTokenCiphertext: string | null;
  refreshTokenIv: string | null;
  refreshTokenTag: string | null;
  tokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  scopes: string | null;
  lastSyncAt: Date | null;
  lastSyncDurationMs: number | null;
  lastError: string | null;
  ecommerceStoreId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT_COLS = `
  "id", "companyId", "shopDomain", "status",
  "accessTokenCiphertext", "accessTokenIv", "accessTokenTag",
  "refreshTokenCiphertext", "refreshTokenIv", "refreshTokenTag",
  "tokenExpiresAt", "refreshTokenExpiresAt", "scopes",
  "lastSyncAt", "lastSyncDurationMs", "lastError", "ecommerceStoreId",
  "createdAt", "updatedAt"
`;

export async function getConnection(
  companyId: string,
  shopDomain: string
): Promise<ShopifyConnectionRow | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT ${SELECT_COLS} FROM shopify_connections WHERE "companyId" = $1 AND "shopDomain" = $2 LIMIT 1`,
    companyId,
    shopDomain
  )) as ShopifyConnectionRow[];
  return rows[0] ?? null;
}

export async function getConnectionById(
  companyId: string,
  id: string
): Promise<ShopifyConnectionRow | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT ${SELECT_COLS} FROM shopify_connections WHERE "companyId" = $1 AND "id" = $2 LIMIT 1`,
    companyId,
    id
  )) as ShopifyConnectionRow[];
  return rows[0] ?? null;
}

/**
 * Look up a connection by shop domain alone (webhooks carry the shop, not the
 * company). Prefers a 'connected' row, then most-recently-updated.
 */
export async function getConnectionByShopDomain(
  shopDomain: string
): Promise<ShopifyConnectionRow | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT ${SELECT_COLS} FROM shopify_connections
      WHERE "shopDomain" = $1
      ORDER BY ("status" = 'connected') DESC, "updatedAt" DESC
      LIMIT 1`,
    shopDomain
  )) as ShopifyConnectionRow[];
  return rows[0] ?? null;
}

export async function listConnections(
  companyId: string
): Promise<ShopifyConnectionRow[]> {
  return (await prisma.$queryRawUnsafe(
    `SELECT ${SELECT_COLS} FROM shopify_connections WHERE "companyId" = $1 ORDER BY "createdAt" DESC`,
    companyId
  )) as ShopifyConnectionRow[];
}

function expiryFromSeconds(sec: number | null): Date | null {
  if (sec == null) return null;
  return new Date(Date.now() + sec * 1000);
}

/**
 * Insert or update the connection for (companyId, shopDomain) with freshly
 * issued tokens. Encrypts both tokens. Returns the connection id.
 */
export async function upsertConnectionTokens(params: {
  companyId: string;
  shopDomain: string;
  tokens: ShopifyTokenSet;
  ecommerceStoreId?: string | null;
}): Promise<string> {
  const { companyId, shopDomain, tokens, ecommerceStoreId } = params;
  const access = encryptToken(tokens.accessToken);
  const refresh = tokens.refreshToken ? encryptToken(tokens.refreshToken) : null;
  const tokenExpiresAt = expiryFromSeconds(tokens.expiresInSec);
  const refreshExpiresAt = expiryFromSeconds(tokens.refreshTokenExpiresInSec);

  const existing = await getConnection(companyId, shopDomain);
  if (existing) {
    await prisma.$executeRawUnsafe(
      `UPDATE shopify_connections SET
         "status" = 'connected',
         "accessTokenCiphertext" = $1, "accessTokenIv" = $2, "accessTokenTag" = $3,
         "refreshTokenCiphertext" = $4, "refreshTokenIv" = $5, "refreshTokenTag" = $6,
         "tokenExpiresAt" = $7, "refreshTokenExpiresAt" = $8, "scopes" = $9,
         "lastError" = NULL,
         "ecommerceStoreId" = COALESCE($10, "ecommerceStoreId"),
         "updatedAt" = NOW()
       WHERE "id" = $11`,
      access.ciphertext, access.iv, access.tag,
      refresh?.ciphertext ?? null, refresh?.iv ?? null, refresh?.tag ?? null,
      tokenExpiresAt, refreshExpiresAt, tokens.scope,
      ecommerceStoreId ?? null, existing.id
    );
    return existing.id;
  }

  const id = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO shopify_connections (
       "id", "companyId", "shopDomain", "status",
       "accessTokenCiphertext", "accessTokenIv", "accessTokenTag",
       "refreshTokenCiphertext", "refreshTokenIv", "refreshTokenTag",
       "tokenExpiresAt", "refreshTokenExpiresAt", "scopes", "ecommerceStoreId",
       "createdAt", "updatedAt"
     ) VALUES ($1,$2,$3,'connected',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW())`,
    id, companyId, shopDomain,
    access.ciphertext, access.iv, access.tag,
    refresh?.ciphertext ?? null, refresh?.iv ?? null, refresh?.tag ?? null,
    tokenExpiresAt, refreshExpiresAt, tokens.scope, ecommerceStoreId ?? null
  );
  return id;
}

export async function setStatus(
  id: string,
  status: ConnectionStatus,
  lastError?: string | null
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE shopify_connections SET "status" = $1, "lastError" = $2, "updatedAt" = NOW() WHERE "id" = $3`,
    status,
    lastError ?? null,
    id
  );
}

export async function recordSyncResult(
  id: string,
  durationMs: number,
  error?: string | null
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE shopify_connections SET
       "lastSyncAt" = NOW(), "lastSyncDurationMs" = $1, "lastError" = $2, "updatedAt" = NOW()
     WHERE "id" = $3`,
    durationMs,
    error ?? null,
    id
  );
}

export async function linkEcommerceStore(id: string, ecommerceStoreId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE shopify_connections SET "ecommerceStoreId" = $1, "updatedAt" = NOW() WHERE "id" = $2`,
    ecommerceStoreId,
    id
  );
}

export async function deleteConnection(companyId: string, id: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `DELETE FROM shopify_connections WHERE "companyId" = $1 AND "id" = $2`,
    companyId,
    id
  );
}

function decryptAccess(conn: ShopifyConnectionRow): string {
  if (!conn.accessTokenCiphertext || !conn.accessTokenIv || !conn.accessTokenTag) {
    throw integrationError("NEEDS_REAUTH", "Connection has no stored access token", {
      companyId: conn.companyId,
      shop: conn.shopDomain,
    });
  }
  return decryptToken({
    ciphertext: conn.accessTokenCiphertext,
    iv: conn.accessTokenIv,
    tag: conn.accessTokenTag,
  });
}

// Refresh when within this window of expiry (or already expired).
const REFRESH_SKEW_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Return a valid access token for the connection, refreshing + rotating it if
 * it is expired/near-expiry. Used before any Admin API call. On a
 * revocation-type refresh failure the connection is flagged needs_reauth and
 * a typed NEEDS_REAUTH error is thrown (never silently looped).
 */
export async function getValidAccessToken(conn: ShopifyConnectionRow): Promise<string> {
  if (conn.status === "needs_reauth" || conn.status === "revoked") {
    throw integrationError("NEEDS_REAUTH", `Connection ${conn.id} requires reconnect`, {
      companyId: conn.companyId,
      shop: conn.shopDomain,
    });
  }

  const expired =
    conn.tokenExpiresAt != null &&
    conn.tokenExpiresAt.getTime() - Date.now() <= REFRESH_SKEW_MS;

  // Legacy non-expiring token (tokenExpiresAt null) → use as-is.
  if (!expired) {
    return decryptAccess(conn);
  }

  // Need to refresh. Without a refresh token we can't — require reconnect.
  if (!conn.refreshTokenCiphertext || !conn.refreshTokenIv || !conn.refreshTokenTag) {
    await setStatus(conn.id, "needs_reauth", "Access token expired and no refresh token on file");
    throw integrationError("NEEDS_REAUTH", "No refresh token; reconnect required", {
      companyId: conn.companyId,
      shop: conn.shopDomain,
    });
  }

  const refreshToken = decryptToken({
    ciphertext: conn.refreshTokenCiphertext,
    iv: conn.refreshTokenIv,
    tag: conn.refreshTokenTag,
  });

  try {
    const rotated = await refreshAccessToken(conn.shopDomain, refreshToken);
    await upsertConnectionTokens({
      companyId: conn.companyId,
      shopDomain: conn.shopDomain,
      tokens: rotated,
      ecommerceStoreId: conn.ecommerceStoreId,
    });
    await recordIntegrationEvent({
      companyId: conn.companyId,
      eventType: "token_refresh",
      requestContext: { shop: conn.shopDomain, connectionId: conn.id },
    });
    return rotated.accessToken;
  } catch (err) {
    // Mark needs_reauth so the UI prompts a reconnect; surface to caller.
    await setStatus(conn.id, "needs_reauth", "Token refresh failed");
    await recordIntegrationEvent({
      companyId: conn.companyId,
      eventType: "token_refresh_failure",
      errorCode: "TOKEN_REFRESH_FAILED",
      errorMessage: (err as Error).message,
      requestContext: { shop: conn.shopDomain, connectionId: conn.id },
    });
    throw err;
  }
}
