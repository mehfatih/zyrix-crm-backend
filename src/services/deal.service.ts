import { prisma } from "../config/database";
import { badRequest, notFound } from "../middleware/errorHandler";
import type { Prisma } from "@prisma/client";
import {
  dispatchDealCreated,
  dispatchDealStageChanged,
} from "./workflow-events.service";

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

// Updated to accept null for date fields (to match Zod schema)
export interface UpdateDealDto {
  title?: string;
  value?: number;
  currency?: string;
  stage?: string;
  probability?: number;
  expectedCloseDate?: string | null;
  actualCloseDate?: string | null;
  description?: string;
  lostReason?: string;
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
  const customer = await prisma.customer.findFirst({
    where: { id: dto.customerId, companyId },
  });
  if (!customer) throw badRequest("Customer not found in this company");

  if (dto.stage && !VALID_STAGES.includes(dto.stage as typeof VALID_STAGES[number])) {
    throw badRequest(`Invalid stage. Must be one of: ${VALID_STAGES.join(", ")}`);
  }

  const deal = await prisma.deal.create({
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

  dispatchDealCreated(
    companyId,
    {
      id: deal.id,
      title: deal.title,
      value: Number(deal.value),
      currency: deal.currency,
      stage: deal.stage,
      customerId: deal.customerId,
    },
    deal.customer
      ? {
          id: deal.customer.id,
          fullName: deal.customer.fullName,
          email: deal.customer.email,
          phone: null,
          status: "new",
          source: null,
        }
      : null
  ).catch(() => {});

  return deal;
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
// UPDATE
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
  const autoCloseDate =
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

  const updateData: Prisma.DealUpdateInput = {};
  if (dto.title !== undefined) updateData.title = dto.title;
  if (dto.value !== undefined) updateData.value = dto.value;
  if (dto.currency !== undefined) updateData.currency = dto.currency;
  if (dto.stage !== undefined) updateData.stage = dto.stage;
  if (dto.probability !== undefined) updateData.probability = dto.probability;
  if (dto.description !== undefined) updateData.description = dto.description;
  if (dto.lostReason !== undefined) updateData.lostReason = dto.lostReason;

  // Handle date fields (can be string, null, or undefined)
  if (dto.expectedCloseDate !== undefined) {
    updateData.expectedCloseDate = dto.expectedCloseDate
      ? new Date(dto.expectedCloseDate)
      : null;
  }
  if (dto.actualCloseDate !== undefined) {
    updateData.actualCloseDate = dto.actualCloseDate
      ? new Date(dto.actualCloseDate)
      : null;
  } else if (autoCloseDate) {
    updateData.actualCloseDate = autoCloseDate;
  }

  // Handle owner (can be null to unassign)
  if (dto.ownerId !== undefined) {
    updateData.owner = dto.ownerId
      ? { connect: { id: dto.ownerId } }
      : { disconnect: true };
  }

  return prisma.deal.update({
    where: { id: dealId },
    data: updateData,
    include: {
      customer: { select: { id: true, fullName: true, companyName: true, email: true, phone: true, status: true, source: true } },
      owner: { select: { id: true, fullName: true } },
    },
  }).then(async (updated) => {
    // Auto-create commission entries when deal transitions to 'won'
    if (dto.stage === "won" && existing.stage !== "won") {
      try {
        const { createEntriesForWonDeal } = await import(
          "./commission.service"
        );
        await createEntriesForWonDeal(companyId, dealId);
      } catch {
        // Non-fatal: deal update should succeed even if commission fails
      }
    }

    // Fire workflow triggers when stage actually changes. dispatchDealStageChanged
    // fans out to deal.stage_changed + deal.won / deal.lost when terminal.
    if (dto.stage !== undefined && dto.stage !== existing.stage) {
      dispatchDealStageChanged(
        companyId,
        {
          id: updated.id,
          title: updated.title,
          value: Number(updated.value),
          currency: updated.currency,
          stage: updated.stage,
          customerId: updated.customerId,
        },
        updated.customer
          ? {
              id: updated.customer.id,
              fullName: updated.customer.fullName,
              email: updated.customer.email,
              phone: updated.customer.phone,
              status: updated.customer.status,
              source: updated.customer.source,
            }
          : null,
        existing.stage
      ).catch(() => {});
    }

    return updated;
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
// PIPELINE
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