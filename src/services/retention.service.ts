// ============================================================================
// DATA RETENTION (P5)
// ----------------------------------------------------------------------------
// CRUD + the cron executor that actually prunes old rows. Supported entity
// types are gated explicitly — adding a new one means extending both the
// SUPPORTED_ENTITIES array (for the admin UI) and deletePoliciesPass().
// ============================================================================

import { prisma } from "../config/database";
import { badRequest, notFound } from "../middleware/errorHandler";

export type RetentionEntity =
  | "audit_log"
  | "activity"
  | "session_event"
  | "message";

export const SUPPORTED_ENTITIES: RetentionEntity[] = [
  "audit_log",
  "activity",
  "session_event",
  "message",
];

// 30 days minimum; 7 years (2555 days) maximum. 0 means "forever".
const MIN_DAYS = 30;
const MAX_DAYS = 2555;

export interface RetentionPolicy {
  id: string;
  companyId: string;
  entityType: string;
  retentionDays: number;
  legalHold: boolean;
  legalHoldReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function listPolicies(
  companyId: string
): Promise<RetentionPolicy[]> {
  return prisma.retentionPolicy.findMany({
    where: { companyId },
    orderBy: { entityType: "asc" },
  });
}

export interface UpsertPolicyInput {
  entityType: string;
  retentionDays: number;
  legalHold?: boolean;
  legalHoldReason?: string | null;
}

export async function upsertPolicy(
  companyId: string,
  input: UpsertPolicyInput
): Promise<RetentionPolicy> {
  if (!(SUPPORTED_ENTITIES as string[]).includes(input.entityType)) {
    throw badRequest(`Unsupported entityType: ${input.entityType}`);
  }
  const days = Math.floor(input.retentionDays);
  if (days !== 0 && (days < MIN_DAYS || days > MAX_DAYS)) {
    throw badRequest(
      `retentionDays must be 0 (forever) or between ${MIN_DAYS} and ${MAX_DAYS}`
    );
  }
  const legalHold = input.legalHold === true;
  if (legalHold && !input.legalHoldReason?.trim()) {
    throw badRequest("legalHoldReason is required when legalHold is true");
  }
  const row = await prisma.retentionPolicy.upsert({
    where: {
      companyId_entityType: {
        companyId,
        entityType: input.entityType,
      },
    },
    create: {
      companyId,
      entityType: input.entityType,
      retentionDays: days,
      legalHold,
      legalHoldReason: legalHold ? (input.legalHoldReason ?? null) : null,
    },
    update: {
      retentionDays: days,
      legalHold,
      legalHoldReason: legalHold ? (input.legalHoldReason ?? null) : null,
    },
  });
  return row;
}

export async function deletePolicy(
  companyId: string,
  entityType: string
): Promise<{ deleted: boolean }> {
  const existing = await prisma.retentionPolicy.findUnique({
    where: {
      companyId_entityType: { companyId, entityType },
    },
  });
  if (!existing) throw notFound("Retention policy");
  await prisma.retentionPolicy.delete({
    where: {
      companyId_entityType: { companyId, entityType },
    },
  });
  return { deleted: true };
}

// ──────────────────────────────────────────────────────────────────────
// Cron pass — hard-delete expired rows. Called daily from
// src/cron/data-retention.ts. Safe to run ad-hoc for testing.
// ──────────────────────────────────────────────────────────────────────

export interface PruneResult {
  companyId: string;
  entityType: string;
  deleted: number;
}

async function pruneOne(
  companyId: string,
  entityType: RetentionEntity,
  cutoff: Date
): Promise<number> {
  switch (entityType) {
    case "audit_log": {
      const r = await prisma.auditLog.deleteMany({
        where: { companyId, createdAt: { lt: cutoff } },
      });
      return r.count;
    }
    case "activity": {
      const r = await prisma.activity.deleteMany({
        where: { companyId, createdAt: { lt: cutoff } },
      });
      return r.count;
    }
    case "session_event": {
      const r = await prisma.sessionEvent.deleteMany({
        where: { companyId, createdAt: { lt: cutoff } },
      });
      return r.count;
    }
    case "message": {
      const r = await prisma.chatMessage.deleteMany({
        where: { companyId, createdAt: { lt: cutoff } },
      });
      return r.count;
    }
    default:
      return 0;
  }
}

export async function runRetentionPass(): Promise<PruneResult[]> {
  const now = Date.now();
  const policies = await prisma.retentionPolicy.findMany({
    where: {
      legalHold: false,
      retentionDays: { gt: 0 },
    },
  });

  const results: PruneResult[] = [];
  for (const p of policies) {
    const cutoff = new Date(now - p.retentionDays * 24 * 60 * 60 * 1000);
    if (!(SUPPORTED_ENTITIES as string[]).includes(p.entityType)) continue;
    try {
      const deleted = await pruneOne(
        p.companyId,
        p.entityType as RetentionEntity,
        cutoff
      );
      results.push({
        companyId: p.companyId,
        entityType: p.entityType,
        deleted,
      });
    } catch (err) {
      console.error(
        `[retention] prune failed for ${p.companyId}/${p.entityType}:`,
        err
      );
    }
  }
  return results;
}
