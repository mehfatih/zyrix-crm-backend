// ============================================================================
// OAUTH STATE SERVICE
// ----------------------------------------------------------------------------
// Manages transient rows tracking in-flight OAuth install flows. Each row
// is a short-lived nonce that ties a provider consent screen to a specific
// Zyrix user/company so we can securely round-trip back.
//
// Lifecycle:
//   1. createState({ provider, companyId, userId, returnUrl, metadata })
//      → generates random 32-char state, inserts row with 15-minute expiry
//   2. Provider redirects back with ?state=<nonce>&code=<authcode>
//   3. consumeState(state) → validates expiry + deletes row (one-shot),
//      returns the original companyId/userId/metadata so the callback
//      handler can proceed with the code exchange
//
// Old expired rows are cleaned up by a cron hourly.
// ============================================================================

import crypto from "crypto";
import { prisma } from "../config/database";

const STATE_TTL_MINUTES = 15;

export type OAuthProvider = "salla" | "shopify";

export interface CreateStateInput {
  provider: OAuthProvider;
  companyId: string;
  userId: string;
  returnUrl?: string;
  metadata?: Record<string, unknown>;
}

export async function createState(input: CreateStateInput): Promise<string> {
  // 32 hex chars = 128 bits of entropy — plenty for an anti-CSRF nonce.
  const state = crypto.randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + STATE_TTL_MINUTES * 60 * 1000);

  // Sanitize returnUrl — must be a relative path starting with '/' so we
  // can't be tricked into redirecting to a phishing domain.
  const safeReturnUrl =
    input.returnUrl && input.returnUrl.startsWith("/") && !input.returnUrl.startsWith("//")
      ? input.returnUrl
      : "/integrations";

  await prisma.$executeRawUnsafe(
    `INSERT INTO oauth_states
       (id, state, provider, "companyId", "userId", "returnUrl", metadata, "expiresAt", "createdAt")
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6::jsonb, $7, NOW())`,
    state,
    input.provider,
    input.companyId,
    input.userId,
    safeReturnUrl,
    JSON.stringify(input.metadata ?? {}),
    expiresAt
  );
  return state;
}

export interface ConsumedState {
  provider: OAuthProvider;
  companyId: string;
  userId: string;
  returnUrl: string;
  metadata: Record<string, unknown>;
}

/**
 * Look up a state row, delete it, and return its payload. Returns null if
 * the state is unknown or expired — callers should treat either case as
 * the same error ('invalid state') to avoid leaking whether a state ever
 * existed.
 */
export async function consumeState(
  state: string
): Promise<ConsumedState | null> {
  if (!state || typeof state !== "string") return null;

  const rows = (await prisma.$queryRawUnsafe(
    `DELETE FROM oauth_states
     WHERE state = $1 AND "expiresAt" > NOW()
     RETURNING provider, "companyId", "userId", "returnUrl", metadata`,
    state
  )) as Array<{
    provider: string;
    companyId: string;
    userId: string;
    returnUrl: string;
    metadata: Record<string, unknown>;
  }>;

  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    provider: row.provider as OAuthProvider,
    companyId: row.companyId,
    userId: row.userId,
    returnUrl: row.returnUrl,
    metadata: row.metadata ?? {},
  };
}

/**
 * Cron-driven cleanup. Keeps the oauth_states table tiny — without this
 * abandoned install attempts would pile up forever.
 */
export async function pruneExpiredStates(): Promise<number> {
  const result = (await prisma.$queryRawUnsafe(
    `DELETE FROM oauth_states WHERE "expiresAt" <= NOW() RETURNING id`
  )) as { id: string }[];
  return result.length;
}
