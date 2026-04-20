import { prisma } from "../config/database";
import { notFound } from "../middleware/errorHandler";
import type { Prisma } from "@prisma/client";

// ============================================================================
// LOYALTY SERVICE
// ============================================================================

export type LoyaltyTxnType = "earn" | "redeem" | "adjust" | "expire";

export interface LoyaltyTier {
  name: string;
  threshold: number;
  multiplier: number;
}

export interface UpsertProgramDto {
  name?: string;
  isActive?: boolean;
  pointsPerUnit?: number;
  currency?: string;
  minRedeem?: number;
  redeemValue?: number;
  tiers?: LoyaltyTier[];
  rules?: Record<string, unknown>;
}

export interface CreateTxnDto {
  customerId: string;
  points: number;
  type: LoyaltyTxnType;
  reason?: string;
  referenceType?: string;
  referenceId?: string;
}

export interface ListTxnsQuery {
  page?: number;
  limit?: number;
  customerId?: string;
  type?: LoyaltyTxnType;
}

// ─────────────────────────────────────────────────────────────────────────
// Program (upsert — one per company)
// ─────────────────────────────────────────────────────────────────────────
export async function getProgram(companyId: string) {
  const program = await prisma.loyaltyProgram.findUnique({
    where: { companyId },
  });
  if (!program) {
    // Return defaults (not yet persisted)
    return {
      id: null,
      companyId,
      name: "Loyalty Program",
      isActive: false,
      pointsPerUnit: "1",
      currency: "TRY",
      minRedeem: 0,
      redeemValue: "0.01",
      tiers: null,
      rules: null,
      createdAt: null,
      updatedAt: null,
    };
  }
  return program;
}

export async function upsertProgram(
  companyId: string,
  dto: UpsertProgramDto
) {
  const data: any = {};
  if (dto.name !== undefined) data.name = dto.name.trim();
  if (dto.isActive !== undefined) data.isActive = dto.isActive;
  if (dto.pointsPerUnit !== undefined) data.pointsPerUnit = dto.pointsPerUnit;
  if (dto.currency !== undefined) data.currency = dto.currency;
  if (dto.minRedeem !== undefined) data.minRedeem = dto.minRedeem;
  if (dto.redeemValue !== undefined) data.redeemValue = dto.redeemValue;
  if (dto.tiers !== undefined) data.tiers = dto.tiers as any;
  if (dto.rules !== undefined) data.rules = dto.rules as any;

  return prisma.loyaltyProgram.upsert({
    where: { companyId },
    create: {
      companyId,
      name: dto.name ?? "Loyalty Program",
      isActive: dto.isActive ?? true,
      pointsPerUnit: dto.pointsPerUnit ?? 1,
      currency: dto.currency ?? "TRY",
      minRedeem: dto.minRedeem ?? 0,
      redeemValue: dto.redeemValue ?? 0.01,
      tiers: (dto.tiers as any) ?? undefined,
      rules: (dto.rules as any) ?? undefined,
    },
    update: data,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Transactions
// ─────────────────────────────────────────────────────────────────────────
export async function createTransaction(
  companyId: string,
  userId: string,
  dto: CreateTxnDto
) {
  const customer = await prisma.customer.findFirst({
    where: { id: dto.customerId, companyId },
    select: { id: true },
  });
  if (!customer) throw notFound("Customer");

  const program = await prisma.loyaltyProgram.findUnique({
    where: { companyId },
  });
  if (!program) {
    const err: any = new Error("Loyalty program is not set up");
    err.statusCode = 400;
    throw err;
  }

  // If redeeming, check sufficient balance
  if (dto.type === "redeem") {
    const balance = await getCustomerBalance(companyId, dto.customerId);
    const redeemAmount = Math.abs(dto.points);
    if (redeemAmount > balance) {
      const err: any = new Error(
        `Insufficient points. Customer has ${balance} points.`
      );
      err.statusCode = 400;
      throw err;
    }
  }

  // Normalize sign: earn positive, redeem negative
  let points = dto.points;
  if (dto.type === "redeem" && points > 0) points = -points;
  if (dto.type === "earn" && points < 0) points = -points;

  return prisma.loyaltyTransaction.create({
    data: {
      companyId,
      customerId: dto.customerId,
      programId: program.id,
      createdById: userId,
      points,
      type: dto.type,
      reason: dto.reason?.trim() || null,
      referenceType: dto.referenceType ?? null,
      referenceId: dto.referenceId ?? null,
    },
    include: {
      customer: { select: { id: true, fullName: true, companyName: true } },
      createdBy: { select: { id: true, fullName: true, email: true } },
    },
  });
}

export async function listTransactions(
  companyId: string,
  q: ListTxnsQuery
) {
  const page = Math.max(1, q.page ?? 1);
  const limit = Math.min(200, Math.max(1, q.limit ?? 50));
  const skip = (page - 1) * limit;

  const where: Prisma.LoyaltyTransactionWhereInput = { companyId };
  if (q.customerId) where.customerId = q.customerId;
  if (q.type) where.type = q.type;

  const [total, items] = await Promise.all([
    prisma.loyaltyTransaction.count({ where }),
    prisma.loyaltyTransaction.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        customer: {
          select: { id: true, fullName: true, companyName: true },
        },
        createdBy: { select: { id: true, fullName: true, email: true } },
      },
    }),
  ]);

  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function deleteTransaction(companyId: string, txnId: string) {
  const existing = await prisma.loyaltyTransaction.findFirst({
    where: { id: txnId, companyId },
    select: { id: true },
  });
  if (!existing) throw notFound("Transaction");
  await prisma.loyaltyTransaction.delete({ where: { id: txnId } });
  return { deleted: true };
}

// ─────────────────────────────────────────────────────────────────────────
// Balance + customer info
// ─────────────────────────────────────────────────────────────────────────
export async function getCustomerBalance(
  companyId: string,
  customerId: string
): Promise<number> {
  const agg = await prisma.loyaltyTransaction.aggregate({
    where: { companyId, customerId },
    _sum: { points: true },
  });
  return agg._sum.points ?? 0;
}

export async function getCustomerLoyalty(
  companyId: string,
  customerId: string
) {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, companyId },
    select: { id: true, fullName: true, companyName: true, email: true },
  });
  if (!customer) throw notFound("Customer");

  const [balance, txns, program] = await Promise.all([
    getCustomerBalance(companyId, customerId),
    prisma.loyaltyTransaction.findMany({
      where: { companyId, customerId },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        createdBy: { select: { id: true, fullName: true, email: true } },
      },
    }),
    prisma.loyaltyProgram.findUnique({ where: { companyId } }),
  ]);

  const tier = computeTier(balance, program?.tiers as LoyaltyTier[] | null);

  return { customer, balance, tier, transactions: txns, program };
}

function computeTier(
  balance: number,
  tiers: LoyaltyTier[] | null | undefined
): LoyaltyTier | null {
  if (!tiers || tiers.length === 0) return null;
  const sorted = [...tiers].sort((a, b) => b.threshold - a.threshold);
  return sorted.find((t) => balance >= t.threshold) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────
// Stats (program-wide)
// ─────────────────────────────────────────────────────────────────────────
export async function getProgramStats(companyId: string) {
  const [activeMembers, totalEarned, totalRedeemed, recentTxns] =
    await Promise.all([
      prisma.loyaltyTransaction.findMany({
        where: { companyId },
        distinct: ["customerId"],
        select: { customerId: true },
      }),
      prisma.loyaltyTransaction.aggregate({
        where: { companyId, type: "earn" },
        _sum: { points: true },
      }),
      prisma.loyaltyTransaction.aggregate({
        where: { companyId, type: "redeem" },
        _sum: { points: true },
      }),
      prisma.loyaltyTransaction.count({
        where: {
          companyId,
          createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        },
      }),
    ]);

  return {
    activeMembers: activeMembers.length,
    totalEarned: totalEarned._sum.points ?? 0,
    totalRedeemed: Math.abs(totalRedeemed._sum.points ?? 0),
    txnsLast30d: recentTxns,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Top members (by balance)
// ─────────────────────────────────────────────────────────────────────────
export async function getTopMembers(companyId: string, limit = 20) {
  // Aggregate per customer
  const result = await prisma.loyaltyTransaction.groupBy({
    by: ["customerId"],
    where: { companyId },
    _sum: { points: true },
    orderBy: { _sum: { points: "desc" } },
    take: limit,
  });

  if (result.length === 0) return [];

  const customerIds = result.map((r) => r.customerId);
  const customers = await prisma.customer.findMany({
    where: { id: { in: customerIds }, companyId },
    select: { id: true, fullName: true, companyName: true, email: true },
  });
  const map = new Map(customers.map((c) => [c.id, c]));

  return result
    .filter((r) => map.has(r.customerId))
    .map((r) => ({
      customer: map.get(r.customerId)!,
      balance: r._sum.points ?? 0,
    }));
}
