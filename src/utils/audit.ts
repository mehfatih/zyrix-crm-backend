// ============================================================================
// AUDIT LOG — append-only activity trail for security & compliance
// ----------------------------------------------------------------------------
// Every write operation that matters (login, 2FA changes, customer/deal
// deletes, permission grants, webhook secret rotations, etc.) should call
// recordAudit() so an admin can later reconstruct "who did what when".
//
// DESIGN PRINCIPLES
//  • Fire-and-forget — audit writes must NEVER block or fail the primary
//    action they're recording. A full DB disk shouldn't prevent a user
//    from logging in.
//  • Request-scoped metadata — we capture IP + User-Agent at the controller
//    layer via extractRequestMeta(req) since services typically don't hold
//    req references.
//  • Change diffs stored as JSON — minimal shape: { before, after } with
//    only the fields that actually changed, so we don't bloat the table
//    or leak unrelated data.
// ============================================================================

import { prisma } from "../config/database";
import type { Request } from "express";

export interface AuditEntry {
  userId?: string | null;
  companyId?: string | null;
  action: string; // e.g. "user.login", "customer.delete", "2fa.enable"
  entityType?: string | null;
  entityId?: string | null;
  changes?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Append a row to the audit log. Swallows all errors — audit write failures
 * must never propagate up and break the primary action. We log to console
 * so ops can still notice if audit capture is broken.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: entry.userId ?? null,
        companyId: entry.companyId ?? null,
        action: entry.action,
        entityType: entry.entityType ?? null,
        entityId: entry.entityId ?? null,
        changes: (entry.changes ?? null) as any,
        metadata: (entry.metadata ?? null) as any,
        ipAddress: entry.ipAddress ?? null,
        userAgent: entry.userAgent ?? null,
      },
    });
  } catch (err) {
    // Intentional: swallow. Console-log so Railway logs show it.
    console.error("[audit] write failed:", err);
  }
}

/**
 * Extracts IP + User-Agent from an Express request in a proxy-aware way.
 * Works behind Railway's load balancer because app.set('trust proxy', 1)
 * is configured in index.ts.
 */
export function extractRequestMeta(req: Request): {
  ipAddress: string | null;
  userAgent: string | null;
} {
  // req.ip respects 'trust proxy' and returns the real client IP
  // when behind Railway / Cloudflare.
  const ipAddress = req.ip || null;
  const userAgent = req.headers["user-agent"]?.toString() || null;
  return { ipAddress, userAgent };
}

/**
 * Compute a minimal diff between two objects for changes field. Skips
 * fields that are identical, skips password-like fields, and caps each
 * string at 500 chars so a giant payload doesn't bloat the audit table.
 *
 * SECURITY: Never include passwordHash, twoFactorSecret, or refresh
 * tokens here — we strip those by name.
 */
const SENSITIVE_FIELDS = new Set([
  "passwordHash",
  "password",
  "twoFactorSecret",
  "refreshToken",
  "secret",
  "accessToken",
  "apiKey",
  "apiSecret",
]);

export function diffObjects(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined
): Record<string, { before: unknown; after: unknown }> {
  const out: Record<string, { before: unknown; after: unknown }> = {};
  const b = before || {};
  const a = after || {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  for (const k of keys) {
    if (SENSITIVE_FIELDS.has(k)) {
      // Only record that it changed, never the actual value
      if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) {
        out[k] = { before: "[redacted]", after: "[redacted]" };
      }
      continue;
    }
    const bv = b[k];
    const av = a[k];
    if (JSON.stringify(bv) === JSON.stringify(av)) continue;
    out[k] = {
      before: truncate(bv),
      after: truncate(av),
    };
  }
  return out;
}

function truncate(v: unknown): unknown {
  if (typeof v === "string" && v.length > 500) {
    return v.slice(0, 500) + "…";
  }
  return v;
}
