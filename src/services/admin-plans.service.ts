import { prisma } from "../config/database";
import { notFound, badRequest } from "../middleware/errorHandler";
import type { Prisma } from "@prisma/client";

// ============================================================================
// ADMIN — PLANS SERVICE
// ============================================================================

export async function listPlans(includeInactive = false) {
  return prisma.plan.findMany({
    where: includeInactive ? undefined : { isActive: true },
    orderBy: { sortOrder: "asc" },
  });
}

export async function getPlan(id: string) {
  const plan = await prisma.plan.findUnique({ where: { id } });
  if (!plan) {
    throw notFound("Plan");
  }
  return plan;
}

export interface UpdatePlanDto {
  name?: string;
  nameAr?: string;
  nameTr?: string;
  description?: string;
  descriptionAr?: string;
  descriptionTr?: string;
  priceMonthlyUsd?: number;
  priceYearlyUsd?: number;
  priceMonthlyTry?: number;
  priceYearlyTry?: number;
  priceMonthlySar?: number;
  priceYearlySar?: number;
  maxUsers?: number;
  maxCustomers?: number;
  maxDeals?: number;
  maxStorageGb?: number;
  maxWhatsappMsg?: number;
  maxAiTokens?: number;
  features?: string[];
  isActive?: boolean;
  isFeatured?: boolean;
  sortOrder?: number;
  color?: string;
}

export async function updatePlan(
  id: string,
  actorUserId: string,
  dto: UpdatePlanDto
) {
  const existing = await prisma.plan.findUnique({ where: { id } });
  if (!existing) {
    throw notFound("Plan");
  }

  const data: Prisma.PlanUpdateInput = {};
  if (dto.name !== undefined) data.name = dto.name;
  if (dto.nameAr !== undefined) data.nameAr = dto.nameAr;
  if (dto.nameTr !== undefined) data.nameTr = dto.nameTr;
  if (dto.description !== undefined) data.description = dto.description;
  if (dto.descriptionAr !== undefined) data.descriptionAr = dto.descriptionAr;
  if (dto.descriptionTr !== undefined) data.descriptionTr = dto.descriptionTr;
  if (dto.priceMonthlyUsd !== undefined) data.priceMonthlyUsd = dto.priceMonthlyUsd;
  if (dto.priceYearlyUsd !== undefined) data.priceYearlyUsd = dto.priceYearlyUsd;
  if (dto.priceMonthlyTry !== undefined) data.priceMonthlyTry = dto.priceMonthlyTry;
  if (dto.priceYearlyTry !== undefined) data.priceYearlyTry = dto.priceYearlyTry;
  if (dto.priceMonthlySar !== undefined) data.priceMonthlySar = dto.priceMonthlySar;
  if (dto.priceYearlySar !== undefined) data.priceYearlySar = dto.priceYearlySar;
  if (dto.maxUsers !== undefined) data.maxUsers = dto.maxUsers;
  if (dto.maxCustomers !== undefined) data.maxCustomers = dto.maxCustomers;
  if (dto.maxDeals !== undefined) data.maxDeals = dto.maxDeals;
  if (dto.maxStorageGb !== undefined) data.maxStorageGb = dto.maxStorageGb;
  if (dto.maxWhatsappMsg !== undefined) data.maxWhatsappMsg = dto.maxWhatsappMsg;
  if (dto.maxAiTokens !== undefined) data.maxAiTokens = dto.maxAiTokens;
  if (dto.features !== undefined)
    data.features = dto.features as Prisma.InputJsonValue;
  if (dto.isActive !== undefined) data.isActive = dto.isActive;
  if (dto.isFeatured !== undefined) data.isFeatured = dto.isFeatured;
  if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
  if (dto.color !== undefined) data.color = dto.color;

  const updated = await prisma.plan.update({ where: { id }, data });

  await prisma.auditLog.create({
    data: {
      userId: actorUserId,
      action: "plan.update",
      entityType: "plan",
      entityId: id,
      metadata: { changed: Object.keys(dto) } as Prisma.InputJsonValue,
    },
  });

  return updated;
}

// ─────────────────────────────────────────────────────────────────────────
// Plan Overrides (feature unlocks per company)
// ─────────────────────────────────────────────────────────────────────────
export async function listOverrides(companyId?: string) {
  return prisma.planOverride.findMany({
    where: companyId ? { companyId } : undefined,
    include: {
      company: { select: { id: true, name: true, slug: true, plan: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function grantOverride(
  companyId: string,
  featureSlug: string,
  actorUserId: string,
  opts: { enabled?: boolean; expiresAt?: Date | null; reason?: string } = {}
) {
  if (!featureSlug || featureSlug.trim().length === 0) {
    throw badRequest("featureSlug is required");
  }

  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) {
    throw notFound("Company");
  }

  const override = await prisma.planOverride.upsert({
    where: {
      companyId_featureSlug: { companyId, featureSlug },
    },
    create: {
      companyId,
      featureSlug,
      enabled: opts.enabled ?? true,
      expiresAt: opts.expiresAt ?? null,
      reason: opts.reason ?? null,
      grantedBy: actorUserId,
    },
    update: {
      enabled: opts.enabled ?? true,
      expiresAt: opts.expiresAt ?? null,
      reason: opts.reason ?? null,
      grantedBy: actorUserId,
    },
  });

  await prisma.auditLog.create({
    data: {
      userId: actorUserId,
      companyId,
      action: "plan.override.grant",
      entityType: "plan_override",
      entityId: override.id,
      metadata: { featureSlug, enabled: override.enabled } as Prisma.InputJsonValue,
    },
  });

  return override;
}

export async function revokeOverride(id: string, actorUserId: string) {
  const override = await prisma.planOverride.findUnique({ where: { id } });
  if (!override) {
    throw notFound("Override");
  }

  await prisma.planOverride.delete({ where: { id } });

  await prisma.auditLog.create({
    data: {
      userId: actorUserId,
      companyId: override.companyId,
      action: "plan.override.revoke",
      entityType: "plan_override",
      entityId: id,
      metadata: { featureSlug: override.featureSlug } as Prisma.InputJsonValue,
    },
  });

  return { id, deleted: true };
}
