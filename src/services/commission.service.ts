import { prisma } from "../config/database";
import { notFound } from "../middleware/errorHandler";
import type { Prisma } from "@prisma/client";

// ============================================================================
// COMMISSION SERVICE
// ============================================================================

export type CommissionType = "flat" | "percent" | "tiered";
export type EntryStatus = "pending" | "approved" | "paid" | "cancelled";
export type AppliesTo = "all" | "deal_stage" | "min_value";

export interface TieredConfig {
  tiers: { from: number; to?: number; rate: number }[];
}

export interface CommissionConfig {
  rate?: number;
  amount?: number;
  tiers?: { from: number; to?: number; rate: number }[];
}

export interface CreateRuleDto {
  name: string;
  description?: string;
  type: CommissionType;
  config: CommissionConfig;
  appliesTo?: AppliesTo;
  appliesToValue?: string;
  isActive?: boolean;
  priority?: number;
}

export interface UpdateRuleDto extends Partial<CreateRuleDto> {}

// ─────────────────────────────────────────────────────────────────────────
// RULES CRUD
// ─────────────────────────────────────────────────────────────────────────
export async function listRules(companyId: string) {
  return prisma.commissionRule.findMany({
    where: { companyId },
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
    include: { _count: { select: { entries: true } } },
  });
}

export async function getRule(companyId: string, id: string) {
  const rule = await prisma.commissionRule.findFirst({
    where: { id, companyId },
  });
  if (!rule) throw notFound("Commission rule");
  return rule;
}

export async function createRule(companyId: string, dto: CreateRuleDto) {
  validateConfig(dto.type, dto.config);
  return prisma.commissionRule.create({
    data: {
      companyId,
      name: dto.name.trim(),
      description: dto.description?.trim() || null,
      type: dto.type,
      config: dto.config as any,
      appliesTo: dto.appliesTo ?? "all",
      appliesToValue: dto.appliesToValue ?? null,
      isActive: dto.isActive ?? true,
      priority: dto.priority ?? 0,
    },
  });
}

export async function updateRule(
  companyId: string,
  id: string,
  dto: UpdateRuleDto
) {
  const existing = await prisma.commissionRule.findFirst({
    where: { id, companyId },
  });
  if (!existing) throw notFound("Commission rule");

  if (dto.type && dto.config) {
    validateConfig(dto.type, dto.config);
  } else if (dto.config) {
    validateConfig(existing.type as CommissionType, dto.config);
  }

  const data: Prisma.CommissionRuleUpdateInput = {};
  if (dto.name !== undefined) data.name = dto.name.trim();
  if (dto.description !== undefined)
    data.description = dto.description?.trim() || null;
  if (dto.type !== undefined) data.type = dto.type;
  if (dto.config !== undefined) data.config = dto.config as any;
  if (dto.appliesTo !== undefined) data.appliesTo = dto.appliesTo;
  if (dto.appliesToValue !== undefined)
    data.appliesToValue = dto.appliesToValue;
  if (dto.isActive !== undefined) data.isActive = dto.isActive;
  if (dto.priority !== undefined) data.priority = dto.priority;

  return prisma.commissionRule.update({ where: { id }, data });
}

export async function deleteRule(companyId: string, id: string) {
  const existing = await prisma.commissionRule.findFirst({
    where: { id, companyId },
    select: { id: true },
  });
  if (!existing) throw notFound("Commission rule");
  await prisma.commissionRule.delete({ where: { id } });
  return { deleted: true };
}

function validateConfig(type: CommissionType, config: CommissionConfig) {
  if (type === "percent") {
    if (config.rate === undefined || config.rate < 0 || config.rate > 100) {
      const err: any = new Error("Percent rule requires rate 0-100");
      err.statusCode = 400;
      throw err;
    }
  } else if (type === "flat") {
    if (config.amount === undefined || config.amount < 0) {
      const err: any = new Error("Flat rule requires non-negative amount");
      err.statusCode = 400;
      throw err;
    }
  } else if (type === "tiered") {
    if (!Array.isArray(config.tiers) || config.tiers.length === 0) {
      const err: any = new Error("Tiered rule requires at least one tier");
      err.statusCode = 400;
      throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// COMPUTE AMOUNT
// ─────────────────────────────────────────────────────────────────────────
export function computeAmount(
  rule: { type: string; config: any },
  baseValue: number
): { amount: number; rate: number } {
  if (rule.type === "flat") {
    const amt = Number(rule.config?.amount) || 0;
    return { amount: amt, rate: 0 };
  }
  if (rule.type === "percent") {
    const rate = Number(rule.config?.rate) || 0;
    const amt = (baseValue * rate) / 100;
    return { amount: Math.round(amt * 100) / 100, rate };
  }
  if (rule.type === "tiered") {
    const tiers: { from: number; to?: number; rate: number }[] =
      rule.config?.tiers ?? [];
    let remaining = baseValue;
    let total = 0;
    const sorted = [...tiers].sort((a, b) => a.from - b.from);
    for (const tier of sorted) {
      const lower = tier.from;
      const upper = tier.to ?? Infinity;
      if (baseValue <= lower) break;
      const inBand = Math.min(baseValue, upper) - lower;
      if (inBand > 0) {
        total += (inBand * tier.rate) / 100;
      }
      if (baseValue <= upper) break;
    }
    return { amount: Math.round(total * 100) / 100, rate: 0 };
  }
  return { amount: 0, rate: 0 };
}

// ─────────────────────────────────────────────────────────────────────────
// AUTO-CREATE ENTRIES ON DEAL WON
// ─────────────────────────────────────────────────────────────────────────
export async function createEntriesForWonDeal(
  companyId: string,
  dealId: string
) {
  const deal = await prisma.deal.findFirst({
    where: { id: dealId, companyId },
  });
  if (!deal || deal.stage !== "won") {
    return { created: 0, message: "Deal is not 'won'" };
  }
  if (!deal.ownerId) {
    return { created: 0, message: "Deal has no owner" };
  }

  const rules = await prisma.commissionRule.findMany({
    where: { companyId, isActive: true },
    orderBy: { priority: "desc" },
  });

  const baseValue = Number(deal.value);
  let created = 0;

  for (const rule of rules) {
    // Check applicability
    if (rule.appliesTo === "deal_stage" && rule.appliesToValue) {
      if (deal.stage !== rule.appliesToValue) continue;
    }
    if (rule.appliesTo === "min_value" && rule.appliesToValue) {
      const min = Number(rule.appliesToValue);
      if (baseValue < min) continue;
    }

    // Skip if entry already exists (unique key enforces this too)
    const existing = await prisma.commissionEntry.findUnique({
      where: {
        dealId_ruleId_userId: {
          dealId: deal.id,
          ruleId: rule.id,
          userId: deal.ownerId,
        },
      },
    });
    if (existing) continue;

    const { amount, rate } = computeAmount(rule, baseValue);
    if (amount <= 0) continue;

    await prisma.commissionEntry.create({
      data: {
        companyId,
        ruleId: rule.id,
        userId: deal.ownerId,
        dealId: deal.id,
        baseValue,
        rate,
        amount,
        currency: deal.currency,
        status: "pending",
      },
    });
    created++;
  }

  return { created };
}

// ─────────────────────────────────────────────────────────────────────────
// MANUALLY RECOMPUTE ALL
// ─────────────────────────────────────────────────────────────────────────
export async function recomputeAll(companyId: string) {
  const wonDeals = await prisma.deal.findMany({
    where: { companyId, stage: "won", ownerId: { not: null } },
    select: { id: true },
  });
  let totalCreated = 0;
  for (const d of wonDeals) {
    const r = await createEntriesForWonDeal(companyId, d.id);
    totalCreated += r.created;
  }
  return { dealsProcessed: wonDeals.length, entriesCreated: totalCreated };
}

// ─────────────────────────────────────────────────────────────────────────
// ENTRIES
// ─────────────────────────────────────────────────────────────────────────
export async function listEntries(
  companyId: string,
  q: {
    userId?: string;
    status?: EntryStatus;
    page?: number;
    limit?: number;
  } = {}
) {
  const page = Math.max(1, q.page ?? 1);
  const limit = Math.min(200, Math.max(1, q.limit ?? 100));
  const skip = (page - 1) * limit;

  const where: Prisma.CommissionEntryWhereInput = { companyId };
  if (q.userId) where.userId = q.userId;
  if (q.status) where.status = q.status;

  const [total, items] = await Promise.all([
    prisma.commissionEntry.count({ where }),
    prisma.commissionEntry.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        user: { select: { id: true, fullName: true, email: true } },
        deal: { select: { id: true, title: true, value: true, currency: true } },
        rule: { select: { id: true, name: true, type: true } },
      },
    }),
  ]);

  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function updateEntryStatus(
  companyId: string,
  id: string,
  status: EntryStatus,
  notes?: string
) {
  const existing = await prisma.commissionEntry.findFirst({
    where: { id, companyId },
  });
  if (!existing) throw notFound("Commission entry");

  const data: Prisma.CommissionEntryUpdateInput = { status };
  if (status === "approved" && !existing.approvedAt)
    data.approvedAt = new Date();
  if (status === "paid" && !existing.paidAt) data.paidAt = new Date();
  if (notes !== undefined) data.notes = notes?.trim() || null;

  return prisma.commissionEntry.update({
    where: { id },
    data,
    include: {
      user: { select: { id: true, fullName: true, email: true } },
      deal: { select: { id: true, title: true } },
      rule: { select: { id: true, name: true } },
    },
  });
}

export async function deleteEntry(companyId: string, id: string) {
  const existing = await prisma.commissionEntry.findFirst({
    where: { id, companyId },
    select: { id: true },
  });
  if (!existing) throw notFound("Commission entry");
  await prisma.commissionEntry.delete({ where: { id } });
  return { deleted: true };
}

// ─────────────────────────────────────────────────────────────────────────
// STATS
// ─────────────────────────────────────────────────────────────────────────
export async function getStats(companyId: string) {
  const [pending, approved, paid, byUserRaw] = await Promise.all([
    prisma.commissionEntry.aggregate({
      where: { companyId, status: "pending" },
      _sum: { amount: true },
      _count: { id: true },
    }),
    prisma.commissionEntry.aggregate({
      where: { companyId, status: "approved" },
      _sum: { amount: true },
      _count: { id: true },
    }),
    prisma.commissionEntry.aggregate({
      where: { companyId, status: "paid" },
      _sum: { amount: true },
      _count: { id: true },
    }),
    prisma.commissionEntry.groupBy({
      by: ["userId"],
      where: { companyId, status: { in: ["pending", "approved"] } },
      _sum: { amount: true },
      _count: { id: true },
      orderBy: { _sum: { amount: "desc" } },
      take: 10,
    }),
  ]);

  const userIds = byUserRaw.map((r) => r.userId);
  const users =
    userIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, fullName: true, email: true },
        })
      : [];
  const userMap = new Map(users.map((u) => [u.id, u]));

  return {
    pendingAmount: Number(pending._sum.amount ?? 0),
    pendingCount: pending._count.id,
    approvedAmount: Number(approved._sum.amount ?? 0),
    approvedCount: approved._count.id,
    paidAmount: Number(paid._sum.amount ?? 0),
    paidCount: paid._count.id,
    topUsers: byUserRaw
      .filter((r) => userMap.has(r.userId))
      .map((r) => ({
        user: userMap.get(r.userId)!,
        amount: Number(r._sum.amount ?? 0),
        count: r._count.id,
      })),
  };
}
