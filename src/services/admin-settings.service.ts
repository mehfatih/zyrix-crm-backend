import { prisma } from "../config/database";
import { randomBytes } from "crypto";
import { hashPassword, comparePassword } from "../utils/password";
import {
  badRequest,
  conflict,
  notFound,
  unauthorized,
} from "../middleware/errorHandler";
import { sendEmail } from "./email.service";
import type { Prisma } from "@prisma/client";

// ============================================================================
// ADMIN — SETTINGS SERVICE
// ============================================================================
// Super admin management and current account settings.
// ============================================================================

// ─────────────────────────────────────────────────────────────────────────
// Super admin list
// ─────────────────────────────────────────────────────────────────────────
export async function listSuperAdmins() {
  return prisma.user.findMany({
    where: { role: "super_admin" },
    select: {
      id: true,
      email: true,
      fullName: true,
      status: true,
      emailVerified: true,
      twoFactorEnabled: true,
      lastLoginAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Invite a new super admin
// ─────────────────────────────────────────────────────────────────────────
export interface InviteSuperAdminDto {
  email: string;
  fullName?: string;
}

export async function inviteSuperAdmin(
  actorUserId: string,
  dto: InviteSuperAdminDto
) {
  const email = dto.email.trim().toLowerCase();

  // 1. Find shadow company
  const shadow = await prisma.company.findUnique({
    where: { slug: "zyrix-system" },
  });
  if (!shadow) {
    throw badRequest(
      "Zyrix System shadow company not found — run bootstrap first."
    );
  }

  // 2. Conflict if the email already belongs to a super_admin
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing && existing.role === "super_admin") {
    throw conflict("This email is already a super admin.");
  }

  // 3. Temp password + invite token
  const tempPassword = generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);
  const inviteToken = randomBytes(24).toString("hex");
  const tokenExpires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7); // 7 days

  let user;
  if (existing) {
    // Promote existing user (e.g., already a tenant owner)
    user = await prisma.user.update({
      where: { id: existing.id },
      data: {
        role: "super_admin",
        passwordHash,
        emailVerified: true,
        status: "active",
        passwordResetToken: inviteToken,
        passwordResetExpires: tokenExpires,
      },
    });
  } else {
    user = await prisma.user.create({
      data: {
        companyId: shadow.id,
        email,
        fullName: dto.fullName?.trim() || email.split("@")[0],
        passwordHash,
        role: "super_admin",
        emailVerified: true,
        status: "active",
        passwordResetToken: inviteToken,
        passwordResetExpires: tokenExpires,
      },
    });
  }

  // 4. Audit
  await prisma.auditLog.create({
    data: {
      userId: actorUserId,
      action: "admin.invite",
      entityType: "user",
      entityId: user.id,
      metadata: {
        email,
        promoted: !!existing,
      } as Prisma.InputJsonValue,
    },
  });

  // 5. Email (best-effort)
  const appUrl = process.env.APP_URL || "https://crm.zyrix.co";
  const loginUrl = `${appUrl}/en/admin/login`;
  const subject = "You've been invited as a Zyrix Super Admin";
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #0F172A;">
      <div style="background: linear-gradient(135deg, #0891B2, #06B6D4); padding: 32px; border-radius: 12px 12px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 20px;">Zyrix CRM — Super Admin invitation</h1>
      </div>
      <div style="background: #fff; border: 1px solid #BAE6FD; border-top: none; padding: 28px; border-radius: 0 0 12px 12px;">
        <p>Hi ${user.fullName},</p>
        <p>You have been granted <strong>Super Admin</strong> access to the Zyrix CRM admin panel.</p>
        <div style="background: #F0F9FF; padding: 16px; border-radius: 8px; margin: 20px 0; border: 1px solid #BAE6FD;">
          <div style="font-size: 12px; color: #64748B; text-transform: uppercase; margin-bottom: 4px;">Temporary password</div>
          <div style="font-family: monospace; font-size: 16px; font-weight: bold; color: #164E63;">${tempPassword}</div>
        </div>
        <p>
          <a href="${loginUrl}" style="display: inline-block; background: #0891B2; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600;">
            Sign in to admin panel
          </a>
        </p>
        <p style="font-size: 12px; color: #64748B; margin-top: 24px;">
          Please change your password after first sign-in. This invite expires in 7 days.
        </p>
      </div>
    </div>
  `;

  await sendEmail({ to: email, subject, html });

  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    tempPassword, // returned so caller can show to admin in case email delivery fails
    inviteToken,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Remove super admin (revoke role back to owner or delete if shadow-only)
// ─────────────────────────────────────────────────────────────────────────
export async function revokeSuperAdmin(
  actorUserId: string,
  targetUserId: string
) {
  if (actorUserId === targetUserId) {
    throw badRequest("You cannot revoke your own super admin role.");
  }

  const user = await prisma.user.findUnique({
    where: { id: targetUserId },
    include: { company: true },
  });
  if (!user) throw notFound("User");
  if (user.role !== "super_admin") {
    throw badRequest("User is not a super admin.");
  }

  // If the user lives only in the shadow company, we disable them instead of
  // demoting (they have no tenant to fall back to).
  const isShadowOnly = user.company.slug === "zyrix-system";

  const updated = await prisma.user.update({
    where: { id: targetUserId },
    data: isShadowOnly
      ? {
          role: "member",
          status: "disabled",
          disabledAt: new Date(),
          disabledReason: "Super admin role revoked",
        }
      : { role: "owner" },
  });

  await prisma.auditLog.create({
    data: {
      userId: actorUserId,
      action: "admin.revoke",
      entityType: "user",
      entityId: targetUserId,
      metadata: {
        wasShadowOnly: isShadowOnly,
      } as Prisma.InputJsonValue,
    },
  });

  return { id: updated.id, email: updated.email, role: updated.role };
}

// ─────────────────────────────────────────────────────────────────────────
// Change current admin's password
// ─────────────────────────────────────────────────────────────────────────
export async function changeAdminPassword(
  userId: string,
  currentPassword: string,
  newPassword: string
) {
  if (newPassword.length < 8) {
    throw badRequest("New password must be at least 8 characters.");
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.passwordHash) throw notFound("User");

  const ok = await comparePassword(currentPassword, user.passwordHash);
  if (!ok) throw unauthorized("Current password is incorrect.");

  const newHash = await hashPassword(newPassword);
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: newHash },
  });

  await prisma.auditLog.create({
    data: {
      userId,
      action: "admin.password_change",
      entityType: "user",
      entityId: userId,
    },
  });

  return { changed: true };
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────
function generateTempPassword(): string {
  const chars =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$";
  let out = "";
  const bytes = randomBytes(16);
  for (let i = 0; i < 16; i++) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}
