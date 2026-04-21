// ============================================================================
// AUDIT LOG — viewing service (company-scoped, for merchant admins)
// ----------------------------------------------------------------------------
// Separate from the super-admin listAuditLogs in admin.controller.ts which
// shows ALL companies' events. This one is scoped to the caller's own
// company and is read-only (audit rows are never updated or deleted via API).
// ============================================================================

import { prisma } from "../config/database";

export interface AuditQueryParams {
  limit?: number;
  offset?: number;
  action?: string;      // exact match, e.g. "user.login"
  actionPrefix?: string; // prefix match, e.g. "customer." for all customer events
  entityType?: string;
  entityId?: string;
  userId?: string;
  since?: Date;
  until?: Date;
}

export async function listCompanyAuditLogs(
  companyId: string,
  params: AuditQueryParams = {}
) {
  const where: any = { companyId };
  if (params.action) where.action = params.action;
  if (params.actionPrefix) where.action = { startsWith: params.actionPrefix };
  if (params.entityType) where.entityType = params.entityType;
  if (params.entityId) where.entityId = params.entityId;
  if (params.userId) where.userId = params.userId;
  if (params.since || params.until) {
    where.createdAt = {};
    if (params.since) where.createdAt.gte = params.since;
    if (params.until) where.createdAt.lte = params.until;
  }

  const limit = Math.min(Math.max(params.limit || 50, 1), 200);
  const offset = Math.max(params.offset || 0, 0);

  const [total, items] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      include: {
        user: {
          select: { id: true, fullName: true, email: true },
        },
      },
    }),
  ]);

  return {
    items,
    pagination: { total, limit, offset },
  };
}

/**
 * Distinct action values for a company — used by the UI's filter dropdown
 * to show what kinds of events exist without hardcoding a list.
 */
export async function listDistinctActions(companyId: string): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({
    where: { companyId },
    select: { action: true },
    distinct: ["action"],
    orderBy: { action: "asc" },
  });
  return rows.map((r) => r.action);
}
