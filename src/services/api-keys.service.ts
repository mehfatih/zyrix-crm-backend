// ============================================================================
// API KEYS SERVICE
// ----------------------------------------------------------------------------
// Creates, lists, revokes, and authenticates API keys used by third-party
// integrations (Zapier, custom scripts). Keys look like:
//     zy_live_<40 hex chars>
// The full string is shown to the user ONCE at creation time. We store
// only a bcrypt hash + the prefix (first 8 chars for identification).
//
// Authentication is O(keys per company) because bcrypt comparisons aren't
// trivially indexable — for companies with dozens of keys we could add
// a separate fast-index column (e.g. sha256 of key) if that becomes a hot
// path. For now, assume <10 active keys per company which is the normal
// pattern (one per integration).
// ============================================================================

import bcrypt from "bcrypt";
import crypto from "crypto";
import { prisma } from "../config/database";
import { notFound, badRequest } from "../middleware/errorHandler";

export interface ApiKeyRow {
  id: string;
  companyId: string;
  createdById: string;
  name: string;
  keyPrefix: string;
  scope: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKeyWithSecret extends ApiKeyRow {
  // Only populated when the key is first created. Not stored.
  plaintextKey: string;
}

// Key format: zy_live_<40 hex chars> → 48 chars total, 8-char prefix
const KEY_PREFIX = "zy_live_";

function generateKey(): { full: string; prefix: string } {
  // 20 bytes → 40 hex chars. Plenty of entropy (160 bits) without being
  // unwieldy. crypto.randomBytes is cryptographically secure.
  const random = crypto.randomBytes(20).toString("hex");
  const full = `${KEY_PREFIX}${random}`;
  // Prefix = first 8 chars AFTER the 'zy_live_' part so users can
  // identify keys in the UI without seeing the secret part.
  const prefix = random.slice(0, 8);
  return { full, prefix };
}

const VALID_SCOPES = new Set(["read", "write"]);

// ──────────────────────────────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────────────────────────────

export async function createApiKey(
  companyId: string,
  userId: string,
  dto: { name: string; scope?: string }
): Promise<ApiKeyWithSecret> {
  if (!dto.name || dto.name.trim().length === 0) {
    throw badRequest("name is required");
  }
  const scope = dto.scope && VALID_SCOPES.has(dto.scope) ? dto.scope : "write";
  const { full, prefix } = generateKey();
  const keyHash = await bcrypt.hash(full, 10);

  const rows = (await prisma.$queryRawUnsafe(
    `INSERT INTO api_keys
       (id, "companyId", "createdById", name, "keyPrefix", "keyHash", scope,
        "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW(), NOW())
     RETURNING id, "companyId", "createdById", name, "keyPrefix", scope,
               "revokedAt", "lastUsedAt", "createdAt", "updatedAt"`,
    companyId,
    userId,
    dto.name.trim(),
    prefix,
    keyHash,
    scope
  )) as ApiKeyRow[];

  return { ...rows[0], plaintextKey: full };
}

export async function listApiKeys(
  companyId: string,
  opts?: { includeRevoked?: boolean }
): Promise<ApiKeyRow[]> {
  const rows = opts?.includeRevoked
    ? ((await prisma.$queryRawUnsafe(
        `SELECT id, "companyId", "createdById", name, "keyPrefix", scope,
                "revokedAt", "lastUsedAt", "createdAt", "updatedAt"
         FROM api_keys
         WHERE "companyId" = $1
         ORDER BY "createdAt" DESC`,
        companyId
      )) as ApiKeyRow[])
    : ((await prisma.$queryRawUnsafe(
        `SELECT id, "companyId", "createdById", name, "keyPrefix", scope,
                "revokedAt", "lastUsedAt", "createdAt", "updatedAt"
         FROM api_keys
         WHERE "companyId" = $1 AND "revokedAt" IS NULL
         ORDER BY "createdAt" DESC`,
        companyId
      )) as ApiKeyRow[]);
  return rows;
}

export async function revokeApiKey(
  companyId: string,
  keyId: string
): Promise<{ revoked: true }> {
  const rows = (await prisma.$queryRawUnsafe(
    `UPDATE api_keys
     SET "revokedAt" = NOW(), "updatedAt" = NOW()
     WHERE id = $1 AND "companyId" = $2 AND "revokedAt" IS NULL
     RETURNING id`,
    keyId,
    companyId
  )) as { id: string }[];

  if (rows.length === 0) {
    // Either doesn't exist, not in this company, or already revoked.
    // Surface the same error either way so an attacker can't probe for
    // valid key IDs.
    throw notFound("Key not found or already revoked");
  }
  return { revoked: true };
}

// ──────────────────────────────────────────────────────────────────────
// AUTHENTICATION
// ──────────────────────────────────────────────────────────────────────

/**
 * Verify a plaintext API key string against the stored hashes.
 * Returns the key row + resolved companyId + userId (the creator) on
 * success. Null on any failure. Never throws for auth failures — the
 * middleware decides how to respond.
 *
 * Updates lastUsedAt asynchronously (fire-and-forget) so repeated calls
 * don't slow down the critical path with an extra write per request.
 */
export async function authenticateApiKey(
  plaintextKey: string
): Promise<{
  keyId: string;
  companyId: string;
  createdById: string;
  scope: string;
} | null> {
  if (
    !plaintextKey ||
    !plaintextKey.startsWith(KEY_PREFIX) ||
    plaintextKey.length !== KEY_PREFIX.length + 40
  ) {
    return null;
  }
  // Extract the 40-hex part, take the first 8 as prefix to narrow search
  const suffix = plaintextKey.slice(KEY_PREFIX.length);
  const prefix = suffix.slice(0, 8);

  // Narrow search by prefix — an 8-char hex prefix has ~4 billion
  // possible values, so match rate is essentially 1-to-1 for real keys.
  const candidates = (await prisma.$queryRawUnsafe(
    `SELECT id, "companyId", "createdById", "keyHash", scope, "revokedAt"
     FROM api_keys WHERE "keyPrefix" = $1 LIMIT 5`,
    prefix
  )) as {
    id: string;
    companyId: string;
    createdById: string;
    keyHash: string;
    scope: string;
    revokedAt: string | null;
  }[];

  for (const cand of candidates) {
    if (cand.revokedAt) continue;
    const ok = await bcrypt.compare(plaintextKey, cand.keyHash);
    if (ok) {
      // Fire-and-forget lastUsedAt update — don't block the request on it
      prisma
        .$executeRawUnsafe(
          `UPDATE api_keys SET "lastUsedAt" = NOW() WHERE id = $1`,
          cand.id
        )
        .catch(() => {
          /* ignore — non-critical */
        });
      return {
        keyId: cand.id,
        companyId: cand.companyId,
        createdById: cand.createdById,
        scope: cand.scope,
      };
    }
  }
  return null;
}
