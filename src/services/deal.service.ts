import { prisma } from "../config/database";
import { badRequest, notFound } from "../middleware/errorHandler";
import type { Prisma } from "@prisma/client";

const VALID_STAGES = [
  "lead",
  "qualified",
  "proposal",
  "negotiation",
  "won",
  "lost",
] as const;

export interface CreateDealDto {
  customerId: string;
  title: string;
  value?: number;
  currency?: string;
  stage?: string;
  probability?: number;
  expectedCloseDate?: string;
  description?: string;
}

export interface UpdateDealDto extends Partial<CreateDealDto> {
  lostReason?: string;
  actualCloseDate?: string;
  ownerId?: string | null;
}

export interface ListDealsQuery {
  page?: number;
  limit?: number;
  stage?: string;
  customerId?: string;
  ownerId?: string;
  sortBy?: "createdAt" | "value" | "expectedCloseDate";
  sortOrder?: "asc" | "desc";
}

// ─────────────────────────────────────────────────────────────────────────
// CREATE
// ─────────────────────────────────────────────────────────────────────────
export async function createDeal(
  companyId: string,
  userId: string,
  dto: CreateDealDto
) {
  // Validate customer exists in the same company
  const customer = await prisma.customer.findFirst({
    where: { id: dto.customerId, companyId },
  });
  if (!customer) throw badRequest("Customer not found in this company");

  if (dto.stage && !VALID_STAGES.includes(dto.stage as typeof VALID_STAGES[number])) {
    throw badRequest(`Invalid stage. Must be one of: ${VALID_STAGES.join(", ")}`);
  }

  return prisma.deal.create({
    data: {
      companyId,
      ownerId: userId,
      customerId: dto.customerId,
      title: dto.title,
      value: dto.value ?? 0,
      currency: dto.currency ?? "USD",
      stage: dto.stage ?? "lead",
      probability: dto.probability ?? 0,
      expectedCloseDate: dto.expectedCloseDate
        ? new Date(dto.expectedCloseDate)
        : null,
      description: dto.description,
    },
    include: {
      customer: {
        select: { id: true, fullName: true, companyName: true, email: true },
      },
      owner: { select: { id: true, fullName: true } },
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// LIST
// ─────────────────────────────────────────────────────────────────────────
export async function listDeals(
  companyId: string,
  query: ListDealsQuery = {}
) {
  const {
    page = 1,
    limit = 20,
    stage,
    customerId,
    ownerId,
    sortBy = "createdAt",
    sortOrder = "desc",
  } = query;

  const skip = (page - 1) * limit;

  const where: Prisma.DealWhereInput = {
    companyId,
    ...(stage && { stage }),
    ...(customerId && { customerId }),
    ...(ownerId && { ownerId }),
  };

  const [deals, total] = await Promise.all([
    prisma.deal.findMany({
      where,
      skip,
      take: limit,
      orderBy: { [sortBy]: sortOrder },
      include: {
        customer: {
          select: { id: true, fullName: true, companyName: true },
        },
        owner: { select: { id: true, fullName: true } },
      },
    }),
    prisma.deal.count({ where }),
  ]);

  return {
    deals,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// GET BY ID
// ─────────────────────────────────────────────────────────────────────────
export async function getDealById(companyId: string, dealId: string) {
  const deal = await prisma.deal.findFirst({
    where: { id: dealId, companyId },
    include: {
      customer: true,
      owner: { select: { id: true, fullName: true, email: true } },
      activities: {
        orderBy: { createdAt: "desc" },
        take: 20,
        include: { user: { select: { id: true, fullName: true } } },
      },
    },
  });

  if (!deal) throw notFound("Deal");
  return deal;
}

// ─────────────────────────────────────────────────────────────────────────
// UPDATE (includes stage transitions)
// ─────────────────────────────────────────────────────────────────────────
export async function updateDeal(
  companyId: string,
  dealId: string,
  dto: UpdateDealDto
) {
  const existing = await prisma.deal.findFirst({
    where: { id: dealId, companyId },
  });
  if (!existing) throw notFound("Deal");

  if (dto.stage && !VALID_STAGES.includes(dto.stage as typeof VALID_STAGES[number])) {
    throw badRequest(`Invalid stage. Must be one of: ${VALID_STAGES.join(", ")}`);
  }

  // Auto-set actualCloseDate when moving to won/lost
  const actualCloseDate =
    (dto.stage === "won" || dto.stage === "lost") && !existing.actualCloseDate
      ? new Date()
      : undefined;

  // Update customer's lifetime value when deal is won
  if (dto.stage === "won" && existing.stage !== "won") {
    await prisma.customer.update({
      where: { id: existing.customerId },
      data: {
        lifetimeValue: {
          increment: existing.value,
        },
        status: "customer",
      },
    });
  }

  return prisma.deal.update({
    where: { id: dealId },
    data: {
      ...(dto.title !== undefined && { title: dto.title }),
      ...(dto.value !== undefined && { value: dto.value }),
      ...(dto.currency !== undefined && { currency: dto.currency }),
      ...(dto.stage !== undefined && { stage: dto.stage }),
      ...(dto.probability !== undefined && { probability: dto.probability }),
      ...(dto.expectedCloseDate !== undefined && {
        expectedCloseDate: dto.expectedCloseDate
          ? new Date(dto.expectedCloseDate)
          : null,
      }),
      ...(actualCloseDate && { actualCloseDate }),
      ...(dto.actualCloseDate !== undefined && {
        actualCloseDate: dto.actualCloseDate
          ? new Date(dto.actualCloseDate)
          : null,
      }),
      ...(dto.description !== undefined && { description: dto.description }),
      ...(dto.lostReason !== undefined && { lostReason: dto.lostReason }),
      ...(dto.ownerId !== undefined && { ownerId: dto.ownerId }),
    },
    include: {
      customer: { select: { id: true, fullName: true, companyName: true } },
      owner: { select: { id: true, fullName: true } },
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────────────────────────────────
export async function deleteDeal(companyId: string, dealId: string) {
  const existing = await prisma.deal.findFirst({
    where: { id: dealId, companyId },
  });
  if (!existing) throw notFound("Deal");

  await prisma.deal.delete({ where: { id: dealId } });
  return { deleted: true };
}

// ─────────────────────────────────────────────────────────────────────────
// PIPELINE VIEW (grouped by stage)
// ─────────────────────────────────────────────────────────────────────────
export async function getPipeline(companyId: string) {
  const deals = await prisma.deal.findMany({
    where: {
      companyId,
      stage: { notIn: ["won", "lost"] },
    },
    include: {
      customer: {
        select: { id: true, fullName: true, companyName: true },
      },
      owner: { select: { id: true, fullName: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  // Group by stage
  const pipeline: Record<string, typeof deals> = {
    lead: [],
    qualified: [],
    proposal: [],
    negotiation: [],
  };

  deals.forEach((deal) => {
    if (pipeline[deal.stage]) {
      pipeline[deal.stage].push(deal);
    }
  });

  // Calculate totals per stage
  const summary = Object.entries(pipeline).map(([stage, stageDeals]) => ({
    stage,
    count: stageDeals.length,
    totalValue: stageDeals.reduce(
      (sum, d) => sum + Number(d.value),
      0
    ),
    weightedValue: stageDeals.reduce(
      (sum, d) => sum + (Number(d.value) * d.probability) / 100,
      0
    ),
  }));

  return { pipeline, summary };
}

// ─────────────────────────────────────────────────────────────────────────
// STATS
// ─────────────────────────────────────────────────────────────────────────
export async function getDealStats(companyId: string) {
  const [total, byStage, won, lost] = await Promise.all([
    prisma.deal.count({ where: { companyId } }),
    prisma.deal.groupBy({
      by: ["stage"],
      where: { companyId },
      _count: true,
      _sum: { value: true },
    }),
    prisma.deal.aggregate({
      where: { companyId, stage: "won" },
      _count: true,
      _sum: { value: true },
    }),
    prisma.deal.aggregate({
      where: { companyId, stage: "lost" },
      _count: true,
      _sum: { value: true },
    }),
  ]);

  return {
    total,
    won: { count: won._count, value: Number(won._sum.value ?? 0) },
    lost: { count: lost._count, value: Number(lost._sum.value ?? 0) },
    byStage: byStage.map((s) => ({
      stage: s.stage,
      count: s._count,
      totalValue: Number(s._sum.value ?? 0),
    })),
  };
}