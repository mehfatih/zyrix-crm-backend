// ============================================================================
// COMPLIANCE SERVICE (P6)
// ----------------------------------------------------------------------------
// Three capabilities, each scoped to a single company:
//   1. Token issuance + verification (bcrypt hashes)
//   2. Per-user data export (GDPR "right to access")
//   3. Per-user data deletion + anonymization (GDPR "right to erasure")
//
// Plus a lightweight aggregated audit report generator for the date-range
// summary endpoint. Exports run inline; for v1 we return JSON rather than
// ZIP/PDF. The frontend can round-trip the JSON through a client-side
// formatter if needed, or a future hardening pass can add streaming zip.
// ============================================================================

import bcrypt from "bcrypt";
import { randomBytes } from "crypto";
import { prisma } from "../config/database";
import { badRequest, notFound } from "../middleware/errorHandler";

// ──────────────────────────────────────────────────────────────────────
// Tokens
// ──────────────────────────────────────────────────────────────────────

function newPlaintextToken(): { plaintext: string; prefix: string } {
  // Format: "comp_<24 base64url chars>" — prefix is first 8 chars after
  // the scheme label, enough for visual identification in the UI without
  // any hash collision risk.
  const raw = randomBytes(18).toString("base64url");
  const plaintext = `comp_${raw}`;
  return { plaintext, prefix: plaintext.slice(0, 12) };
}

export interface IssueTokenResult {
  id: string;
  label: string;
  prefix: string;
  plaintext: string; // shown ONCE
  createdAt: Date;
}

export async function issueComplianceToken(
  companyId: string,
  createdBy: string,
  label: string
): Promise<IssueTokenResult> {
  const trimmed = label.trim();
  if (!trimmed) throw badRequest("label is required");
  if (trimmed.length > 120)
    throw badRequest("label must be 120 chars or less");

  const { plaintext, prefix } = newPlaintextToken();
  const tokenHash = await bcrypt.hash(plaintext, 10);

  const row = await prisma.complianceToken.create({
    data: { companyId, createdBy, label: trimmed, tokenHash, prefix },
    select: { id: true, label: true, prefix: true, createdAt: true },
  });
  return { ...row, plaintext };
}

export interface ComplianceTokenSummary {
  id: string;
  label: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export async function listComplianceTokens(
  companyId: string
): Promise<ComplianceTokenSummary[]> {
  return prisma.complianceToken.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      label: true,
      prefix: true,
      createdAt: true,
      lastUsedAt: true,
      revokedAt: true,
    },
  });
}

export async function revokeComplianceToken(
  companyId: string,
  id: string
): Promise<{ revoked: true }> {
  const row = await prisma.complianceToken.findFirst({
    where: { id, companyId },
  });
  if (!row) throw notFound("Compliance token");
  await prisma.complianceToken.update({
    where: { id },
    data: { revokedAt: new Date() },
  });
  return { revoked: true };
}

/**
 * Verify a plaintext bearer token. Returns the companyId it authenticates
 * to, or null if invalid/revoked. Bumps lastUsedAt asynchronously.
 */
export async function verifyComplianceToken(
  plaintext: string
): Promise<{ companyId: string; id: string } | null> {
  if (!plaintext.startsWith("comp_")) return null;
  const prefix = plaintext.slice(0, 12);
  const candidates = await prisma.complianceToken.findMany({
    where: { prefix, revokedAt: null },
    select: { id: true, companyId: true, tokenHash: true },
    take: 10,
  });
  for (const c of candidates) {
    try {
      const ok = await bcrypt.compare(plaintext, c.tokenHash);
      if (ok) {
        // fire-and-forget timestamp bump
        prisma.complianceToken
          .update({
            where: { id: c.id },
            data: { lastUsedAt: new Date() },
          })
          .catch(() => {});
        return { companyId: c.companyId, id: c.id };
      }
    } catch {
      // ignore
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Per-user data export
// ──────────────────────────────────────────────────────────────────────

export async function exportUserData(companyId: string, userId: string) {
  const user = await prisma.user.findFirst({
    where: { id: userId, companyId },
    select: {
      id: true,
      email: true,
      fullName: true,
      phone: true,
      role: true,
      avatarUrl: true,
      website: true,
      timezone: true,
      billingEmail: true,
      preferredLocale: true,
      lastLoginAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!user) throw notFound("User");

  // Collect the breadth of user-owned data. Each block is a distinct
  // table so downstream consumers (auditors, CSV converters) can pick
  // the slices they care about.
  const [
    ownedCustomers,
    ownedDeals,
    activities,
    auditLogs,
    sessionEvents,
    sentMessages,
    createdQuotes,
    createdContracts,
    createdCampaigns,
    loyaltyTxns,
    commissions,
  ] = await Promise.all([
    prisma.customer.findMany({ where: { companyId, ownerId: userId } }),
    prisma.deal.findMany({ where: { companyId, ownerId: userId } }),
    prisma.activity.findMany({ where: { companyId, userId } }),
    prisma.auditLog.findMany({ where: { companyId, userId } }),
    prisma.sessionEvent.findMany({ where: { companyId, userId } }),
    prisma.chatMessage.findMany({ where: { companyId, fromUserId: userId } }),
    prisma.quote.findMany({ where: { companyId, createdById: userId } }),
    prisma.contract.findMany({ where: { companyId, createdById: userId } }),
    prisma.campaign.findMany({ where: { companyId, createdById: userId } }),
    prisma.loyaltyTransaction.findMany({
      where: { companyId, createdById: userId },
    }),
    prisma.commissionEntry.findMany({ where: { companyId, userId } }),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    companyId,
    user,
    records: {
      ownedCustomers,
      ownedDeals,
      activities,
      auditLogs,
      sessionEvents,
      sentMessages,
      createdQuotes,
      createdContracts,
      createdCampaigns,
      loyaltyTxns,
      commissions,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Per-user data deletion + PII anonymization
// ──────────────────────────────────────────────────────────────────────

export async function deleteUserData(companyId: string, userId: string) {
  const user = await prisma.user.findFirst({
    where: { id: userId, companyId },
    select: { id: true, role: true, email: true },
  });
  if (!user) throw notFound("User");
  if (user.role === "owner" || user.role === "super_admin") {
    throw badRequest(
      "Cannot delete owner or super_admin accounts through the compliance API"
    );
  }

  const anonymizedEmail = `deleted-${user.id}@compliance.invalid`;
  const anonymizedName = "Deleted user";

  // Soft-delete the user + scrub identifying fields. Keep the row so
  // audit + activity FKs remain intact.
  const deletedAt = new Date();
  await prisma.user.update({
    where: { id: userId },
    data: {
      email: anonymizedEmail,
      fullName: anonymizedName,
      phone: null,
      avatarUrl: null,
      website: null,
      billingEmail: null,
      passwordHash: null,
      passwordResetToken: null,
      emailVerificationToken: null,
      twoFactorSecret: null,
      twoFactorEnabled: false,
      twoFactorBackupCodes: [],
      status: "disabled",
      disabledAt: deletedAt,
      disabledReason: "compliance:data_deletion",
      googleId: null,
    },
  });

  // Revoke any active refresh tokens for this user so the session ends.
  await prisma.refreshToken.deleteMany({
    where: { userId },
  });

  return {
    deleted: true,
    userId,
    deletedAt,
    anonymizedEmail,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Audit report
// ──────────────────────────────────────────────────────────────────────

export async function auditReport(
  companyId: string,
  from: Date,
  to: Date
) {
  const where: any = {
    companyId,
    createdAt: { gte: from, lte: to },
  };
  const [total, byAction, byUser] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.groupBy({
      by: ["action"],
      where,
      _count: { _all: true },
      orderBy: { _count: { action: "desc" } },
      take: 50,
    }),
    prisma.auditLog.groupBy({
      by: ["userId"],
      where,
      _count: { _all: true },
      orderBy: { _count: { userId: "desc" } },
      take: 50,
    }),
  ]);

  const userIds = byUser.map((b) => b.userId).filter(Boolean) as string[];
  const userLookup = new Map<string, { fullName: string; email: string }>();
  if (userIds.length > 0) {
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, fullName: true, email: true },
    });
    for (const u of users)
      userLookup.set(u.id, { fullName: u.fullName, email: u.email });
  }

  return {
    generatedAt: new Date().toISOString(),
    companyId,
    window: { from: from.toISOString(), to: to.toISOString() },
    totalEvents: total,
    topActions: byAction.map((b) => ({
      action: b.action,
      count: b._count._all,
    })),
    topUsers: byUser.map((b) => ({
      userId: b.userId,
      user: b.userId ? userLookup.get(b.userId) ?? null : null,
      count: b._count._all,
    })),
  };
}
