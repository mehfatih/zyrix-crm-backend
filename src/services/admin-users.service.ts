import { randomBytes } from "crypto";
import { prisma } from "../config/database";
import { notFound, badRequest, conflict } from "../middleware/errorHandler";
import { hashPassword } from "../utils/password";
import type { Prisma } from "@prisma/client";

// ============================================================================
// ADMIN — USERS SERVICE
// ============================================================================

export interface ListUsersOptions {
  page?: number;
  limit?: number;
  search?: string;
  role?: string;
  status?: string;
  companyId?: string;
  sortBy?: "createdAt" | "email" | "lastLoginAt";
  sortDir?: "asc" | "desc";
}

export async function listUsers(opts: ListUsersOptions = {}) {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
  const skip = (page - 1) * limit;
  const sortBy = opts.sortBy ?? "createdAt";
  const sortDir = opts.sortDir ?? "desc";

  const where: Prisma.UserWhereInput = {};

  if (opts.search) {
    where.OR = [
      { email: { contains: opts.search, mode: "insensitive" } },
      { fullName: { contains: opts.search, mode: "insensitive" } },
      { phone: { contains: opts.search, mode: "insensitive" } },
    ];
  }
  if (opts.role) {
    where.role = opts.role;
  }
  if (opts.status) {
    where.status = opts.status;
  }
  if (opts.companyId) {
    where.companyId = opts.companyId;
  }

  const [total, items] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      skip,
      take: limit,
      orderBy: { [sortBy]: sortDir },
      select: {
        id: true,
        email: true,
        fullName: true,
        phone: true,
        role: true,
        status: true,
        emailVerified: true,
        twoFactorEnabled: true,
        lastLoginAt: true,
        createdAt: true,
        company: {
          select: {
            id: true,
            name: true,
            slug: true,
            plan: true,
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

export async function getUser(id: string) {
  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      fullName: true,
      phone: true,
      role: true,
      status: true,
      emailVerified: true,
      twoFactorEnabled: true,
      lastLoginAt: true,
      disabledAt: true,
      disabledReason: true,
      createdAt: true,
      updatedAt: true,
      company: true,
      _count: {
        select: {
          refreshTokens: true,
          ownedCustomers: true,
          ownedDeals: true,
          activities: true,
        },
      },
    },
  });

  if (!user) {
    throw notFound("User");
  }
  return user;
}

export interface UpdateUserDto {
  fullName?: string;
  phone?: string;
  role?: string;
}

export async function updateUser(
  id: string,
  actorUserId: string,
  dto: UpdateUserDto
) {
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) {
    throw notFound("User");
  }

  // Protect super_admin demotion (only another super_admin from env can do that manually in DB)
  if (
    existing.role === "super_admin" &&
    dto.role !== undefined &&
    dto.role !== "super_admin"
  ) {
    throw badRequest("Cannot demote a super admin via API");
  }

  if (dto.role === "super_admin" && existing.role !== "super_admin") {
    throw badRequest("Cannot promote a user to super admin via API");
  }

  const validRoles = ["super_admin", "owner", "admin", "manager", "member"];
  if (dto.role !== undefined && !validRoles.includes(dto.role)) {
    throw badRequest("Invalid role");
  }

  const updated = await prisma.user.update({
    where: { id },
    data: {
      ...(dto.fullName !== undefined && { fullName: dto.fullName }),
      ...(dto.phone !== undefined && { phone: dto.phone }),
      ...(dto.role !== undefined && { role: dto.role }),
    },
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
      status: true,
      companyId: true,
    },
  });

  await logAdminAction(actorUserId, "user.update", "user", id, {
    before: {
      fullName: existing.fullName,
      role: existing.role,
    },
    after: {
      fullName: updated.fullName,
      role: updated.role,
    },
  });

  return updated;
}

export async function disableUser(
  id: string,
  actorUserId: string,
  reason?: string
) {
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) {
    throw notFound("User");
  }
  if (existing.status === "disabled") {
    throw conflict("User is already disabled");
  }
  if (existing.role === "super_admin") {
    throw badRequest("Cannot disable a super admin");
  }

  const updated = await prisma.user.update({
    where: { id },
    data: {
      status: "disabled",
      disabledAt: new Date(),
      disabledReason: reason ?? null,
    },
  });

  // Revoke all refresh tokens
  await prisma.refreshToken.updateMany({
    where: { userId: id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  await logAdminAction(actorUserId, "user.disable", "user", id, {
    reason: reason ?? null,
  });

  return updated;
}

export async function enableUser(id: string, actorUserId: string) {
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) {
    throw notFound("User");
  }

  const updated = await prisma.user.update({
    where: { id },
    data: {
      status: "active",
      disabledAt: null,
      disabledReason: null,
    },
  });

  await logAdminAction(actorUserId, "user.enable", "user", id);
  return updated;
}

export async function forceResetPassword(id: string, actorUserId: string) {
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) {
    throw notFound("User");
  }

  // Generate a temporary password — admin will share it with user out-of-band
  const tempPassword = generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);

  await prisma.user.update({
    where: { id },
    data: { passwordHash },
  });

  // Revoke all refresh tokens
  await prisma.refreshToken.updateMany({
    where: { userId: id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  await logAdminAction(actorUserId, "user.force_password_reset", "user", id);

  return { tempPassword };
}

function generateTempPassword(): string {
  // 12-char readable password
  const chars =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(10);
  let pwd = "";
  for (let i = 0; i < 10; i++) {
    pwd += chars[bytes[i] % chars.length];
  }
  return `Zx${pwd}!`;
}

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
      },
    });
  } catch {
    // non-critical
  }
}
