import { prisma } from "../config/database";
import { notFound, badRequest, conflict } from "../middleware/errorHandler";
import type { Prisma } from "@prisma/client";

// ============================================================================
// ADMIN — COMPANIES SERVICE
// ============================================================================

export interface ListCompaniesOptions {
  page?: number;
  limit?: number;
  search?: string;
  status?: string;
  plan?: string;
  sortBy?: "createdAt" | "name" | "plan";
  sortDir?: "asc" | "desc";
}

export async function listCompanies(opts: ListCompaniesOptions = {}) {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
  const skip = (page - 1) * limit;
  const sortBy = opts.sortBy ?? "createdAt";
  const sortDir = opts.sortDir ?? "desc";

  const where: Prisma.CompanyWhereInput = {};

  if (opts.search) {
    where.OR = [
      { name: { contains: opts.search, mode: "insensitive" } },
      { slug: { contains: opts.search, mode: "insensitive" } },
      { billingEmail: { contains: opts.search, mode: "insensitive" } },
    ];
  }
  if (opts.status) {
    where.status = opts.status;
  }
  if (opts.plan) {
    where.plan = opts.plan;
  }

  const [total, items] = await Promise.all([
    prisma.company.count({ where }),
    prisma.company.findMany({
      where,
      skip,
      take: limit,
      orderBy: { [sortBy]: sortDir },
      select: {
        id: true,
        name: true,
        slug: true,
        plan: true,
        status: true,
        trialEndsAt: true,
        suspendedAt: true,
        billingEmail: true,
        country: true,
        industry: true,
        size: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            users: true,
            customers: true,
            deals: true,
          },
        },
      },
    }),
  ]);

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

export async function getCompany(id: string) {
  const company = await prisma.company.findUnique({
    where: { id },
    include: {
      _count: {
        select: {
          users: true,
          customers: true,
          deals: true,
          activities: true,
          subscriptions: true,
          payments: true,
          supportTickets: true,
        },
      },
      users: {
        select: {
          id: true,
          email: true,
          fullName: true,
          role: true,
          status: true,
          lastLoginAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      },
      subscriptions: {
        take: 5,
        orderBy: { createdAt: "desc" },
        include: { plan: { select: { name: true, slug: true } } },
      },
      planOverrides: true,
    },
  });

  if (!company) {
    throw notFound("Company");
  }
  return company;
}

export interface UpdateCompanyDto {
  name?: string;
  plan?: string;
  billingEmail?: string;
  country?: string;
  industry?: string;
  size?: string;
  baseCurrency?: string | null;
  idleTimeoutMinutes?: number | null;
}

export async function updateCompany(
  id: string,
  actorUserId: string,
  dto: UpdateCompanyDto
) {
  const existing = await prisma.company.findUnique({ where: { id } });
  if (!existing) {
    throw notFound("Company");
  }

  const updated = await prisma.company.update({
    where: { id },
    data: {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.plan !== undefined && { plan: dto.plan }),
      ...(dto.billingEmail !== undefined && { billingEmail: dto.billingEmail }),
      ...(dto.country !== undefined && { country: dto.country }),
      ...(dto.industry !== undefined && { industry: dto.industry }),
      ...(dto.size !== undefined && { size: dto.size }),
      ...(dto.baseCurrency !== undefined && { baseCurrency: dto.baseCurrency }),
      ...(dto.idleTimeoutMinutes !== undefined && {
        idleTimeoutMinutes: dto.idleTimeoutMinutes,
      }),
    },
  });

  await logAdminAction(actorUserId, "company.update", "company", id, {
    before: existing,
    after: updated,
  });

  return updated;
}

export async function suspendCompany(
  id: string,
  actorUserId: string,
  reason?: string
) {
  const existing = await prisma.company.findUnique({ where: { id } });
  if (!existing) {
    throw notFound("Company");
  }
  if (existing.status === "suspended") {
    throw conflict("Company is already suspended");
  }
  if (existing.slug === "zyrix-system") {
    throw badRequest("Cannot suspend the system company");
  }

  const updated = await prisma.company.update({
    where: { id },
    data: {
      status: "suspended",
      suspendedAt: new Date(),
      suspendReason: reason ?? null,
    },
  });

  await logAdminAction(actorUserId, "company.suspend", "company", id, {
    reason: reason ?? null,
  });

  return updated;
}

export async function resumeCompany(id: string, actorUserId: string) {
  const existing = await prisma.company.findUnique({ where: { id } });
  if (!existing) {
    throw notFound("Company");
  }

  const updated = await prisma.company.update({
    where: { id },
    data: {
      status: "active",
      suspendedAt: null,
      suspendReason: null,
    },
  });

  await logAdminAction(actorUserId, "company.resume", "company", id);
  return updated;
}

export async function deleteCompany(id: string, actorUserId: string) {
  const existing = await prisma.company.findUnique({ where: { id } });
  if (!existing) {
    throw notFound("Company");
  }
  if (existing.slug === "zyrix-system") {
    throw badRequest("Cannot delete the system company");
  }

  // Soft delete first (safer)
  await prisma.company.update({
    where: { id },
    data: {
      status: "deleted",
      deletedAt: new Date(),
    },
  });

  await logAdminAction(actorUserId, "company.delete", "company", id, {
    companyName: existing.name,
    hardDelete: false,
  });

  return { id, deleted: true };
}

export async function impersonateCompanyOwner(
  companyId: string,
  actorUserId: string
) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
  });
  if (!company) {
    throw notFound("Company");
  }

  // Find the owner (or first admin, or first user)
  const owner =
    (await prisma.user.findFirst({
      where: { companyId, role: "owner", status: "active" },
    })) ??
    (await prisma.user.findFirst({
      where: { companyId, role: "admin", status: "active" },
    })) ??
    (await prisma.user.findFirst({
      where: { companyId, status: "active" },
      orderBy: { createdAt: "asc" },
    }));

  if (!owner) {
    throw notFound("No active user in company to impersonate");
  }

  await logAdminAction(
    actorUserId,
    "user.impersonate",
    "user",
    owner.id,
    { companyId, impersonatedUser: owner.email }
  );

  return {
    targetUser: {
      id: owner.id,
      email: owner.email,
      fullName: owner.fullName,
      role: owner.role,
      companyId: owner.companyId,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Impersonate — issue a short-lived access token
// ─────────────────────────────────────────────────────────────────────────
// Returns a real user-scoped JWT (5 minutes) with an `imp: true` claim so
// the frontend can render a persistent "Impersonating" banner. Does NOT
// issue a refresh token — the session is intentionally bounded.
// ─────────────────────────────────────────────────────────────────────────
export async function impersonateCompanyToken(
  companyId: string,
  actorUserId: string
) {
  const { targetUser } = await impersonateCompanyOwner(companyId, actorUserId);

  const targetUserFull = await prisma.user.findUnique({
    where: { id: targetUser.id },
    include: { company: true },
  });
  if (!targetUserFull) {
    throw notFound("Impersonation target user");
  }

  // 5-minute impersonation token. We sign directly with jsonwebtoken so we
  // can embed the `imp` + `impBy` claims without changing the shared types.
  const jwt = (await import("jsonwebtoken")).default;
  const { env } = await import("../config/env");

  const accessToken = jwt.sign(
    {
      userId: targetUserFull.id,
      companyId: targetUserFull.companyId,
      email: targetUserFull.email,
      role: targetUserFull.role,
      type: "access",
      imp: true,
      impBy: actorUserId,
    },
    env.JWT_ACCESS_SECRET,
    { expiresIn: "5m" }
  );

  await logAdminAction(
    actorUserId,
    "user.impersonate_token",
    "user",
    targetUser.id,
    { companyId, expiresIn: "5m" }
  );

  return {
    accessToken,
    expiresIn: 300,
    targetUser: {
      id: targetUserFull.id,
      email: targetUserFull.email,
      fullName: targetUserFull.fullName,
      role: targetUserFull.role,
      companyId: targetUserFull.companyId,
      emailVerified: targetUserFull.emailVerified,
    },
    company: {
      id: targetUserFull.company.id,
      name: targetUserFull.company.name,
      slug: targetUserFull.company.slug,
      plan: targetUserFull.company.plan,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Helper: admin audit logging
// ─────────────────────────────────────────────────────────────────────────
async function logAdminAction(
  userId: string,
  action: string,
  entityType: string,
  entityId: string,
  metadata?: Record<string, unknown>
) {
  try {
    await prisma.auditLog.create({
      data: {
        userId,
        action,
        entityType,
        entityId,
        metadata: metadata as Prisma.InputJsonValue,
        companyId: entityType === "company" ? entityId : undefined,
      },
    });
  } catch {
    // non-critical
  }
}
