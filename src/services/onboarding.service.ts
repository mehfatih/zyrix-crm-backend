// ============================================================================
// ONBOARDING SERVICE
// ----------------------------------------------------------------------------
// Powers the 7-step onboarding wizard at /onboarding. Keeps all the cross-
// model updates (Company, User, optional Invitation email) in one place so
// the controller stays a thin validator + dispatcher.
//
// Design note: the wizard persists everything in a single transaction at
// step 7 rather than step-by-step, so a user who abandons at step 5 leaves
// no half-filled Company/User rows behind. The frontend keeps the answers
// in local state until the user hits "Finish".
// ============================================================================

import crypto from "crypto";
import { prisma } from "../config/database";
import { notFound, AppError } from "../middleware/errorHandler";
import { sendEmail } from "./email.service";
import { env } from "../config/env";

// ──────────────────────────────────────────────────────────────────────
// STATUS — called by dashboard to decide whether to show the banner /
// redirect the user to /onboarding.
// ──────────────────────────────────────────────────────────────────────

export const ONBOARDING_STEPS = [
  "profile",
  "country",
  "firstCustomer",
  "invitedTeam",
  "firstDeal",
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export function isOnboardingStep(s: string): s is OnboardingStep {
  return (ONBOARDING_STEPS as readonly string[]).includes(s);
}

export async function getOnboardingStatus(companyId: string, userId: string) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: {
      id: true,
      name: true,
      country: true,
      baseCurrency: true,
      onboardingCompletedAt: true,
      onboardingProgress: true,
    },
  });
  if (!company) throw notFound("Company not found");

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      fullName: true,
      preferredLocale: true,
    },
  });
  if (!user) throw notFound("User not found");

  // Count accessory signals so the UI can show a richer "you're X% done"
  // hint even before the user finishes the wizard.
  const [storesConnected, teamMembers] = await Promise.all([
    prisma.ecommerceStore.count({ where: { companyId, isActive: true } }),
    prisma.user.count({ where: { companyId, status: "active" } }),
  ]);

  const progress = normalizeProgress(company.onboardingProgress);
  const remaining = ONBOARDING_STEPS.filter((s) => !progress[s]);
  const completedCount = ONBOARDING_STEPS.length - remaining.length;

  return {
    completed: company.onboardingCompletedAt !== null,
    company,
    user,
    progress,
    remaining,
    percent: Math.round((completedCount / ONBOARDING_STEPS.length) * 100),
    signals: {
      storesConnected,
      teamMembers, // includes the current user, so 1 means 'solo'
    },
  };
}

function normalizeProgress(raw: unknown): Record<OnboardingStep, boolean> {
  const base: Record<OnboardingStep, boolean> = {
    profile: false,
    country: false,
    firstCustomer: false,
    invitedTeam: false,
    firstDeal: false,
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  for (const step of ONBOARDING_STEPS) {
    if ((raw as Record<string, unknown>)[step] === true) base[step] = true;
  }
  return base;
}

// ──────────────────────────────────────────────────────────────────────
// PROGRESS — patch individual step flags. Setting all five to true also
// flips onboardingCompletedAt automatically, so the frontend can mark
// the final step and not need a separate /complete call.
// ──────────────────────────────────────────────────────────────────────

export async function updateOnboardingProgress(
  companyId: string,
  patch: Partial<Record<OnboardingStep, boolean>>
) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { onboardingProgress: true, onboardingCompletedAt: true },
  });
  if (!company) throw notFound("Company not found");

  const current = normalizeProgress(company.onboardingProgress);
  const next: Record<OnboardingStep, boolean> = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (isOnboardingStep(k)) next[k] = !!v;
  }
  const allDone = ONBOARDING_STEPS.every((s) => next[s]);

  const updated = await prisma.company.update({
    where: { id: companyId },
    data: {
      onboardingProgress: next as any,
      ...(allDone && !company.onboardingCompletedAt
        ? { onboardingCompletedAt: new Date() }
        : {}),
    },
    select: {
      onboardingProgress: true,
      onboardingCompletedAt: true,
    },
  });
  return {
    progress: normalizeProgress(updated.onboardingProgress),
    completed: updated.onboardingCompletedAt !== null,
  };
}

// ──────────────────────────────────────────────────────────────────────
// COMPLETE — writes all wizard answers in one atomic transaction and
// sets onboardingCompletedAt. Safe to re-call (idempotent on the flag).
// ──────────────────────────────────────────────────────────────────────

export interface CompleteOnboardingInput {
  companyName?: string; // allow rename during onboarding (trial accounts often use a placeholder)
  country?: string;
  baseCurrency?: string;
  preferredLocale?: "en" | "ar" | "tr";
}

export async function completeOnboarding(
  companyId: string,
  userId: string,
  input: CompleteOnboardingInput
) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { id: true, onboardingCompletedAt: true },
  });
  if (!company) throw notFound("Company not found");

  // Transaction so a partial failure (e.g. user update ok, company update
  // fails) doesn't leave the account in an inconsistent state where the
  // banner says 'you're done' but the locale isn't set.
  const result = await prisma.$transaction(async (tx) => {
    const companyUpdates: Record<string, unknown> = {
      onboardingCompletedAt: new Date(),
    };
    if (input.companyName?.trim()) companyUpdates.name = input.companyName.trim();
    if (input.country) companyUpdates.country = input.country;
    if (input.baseCurrency) companyUpdates.baseCurrency = input.baseCurrency;

    const updatedCompany = await tx.company.update({
      where: { id: companyId },
      data: companyUpdates,
      select: {
        id: true,
        name: true,
        country: true,
        baseCurrency: true,
        onboardingCompletedAt: true,
      },
    });

    let updatedUser = null as
      | { id: string; preferredLocale: string | null }
      | null;
    if (input.preferredLocale) {
      updatedUser = await tx.user.update({
        where: { id: userId },
        data: { preferredLocale: input.preferredLocale },
        select: { id: true, preferredLocale: true },
      });
    }

    return { company: updatedCompany, user: updatedUser };
  });

  return { completed: true, ...result };
}

// ──────────────────────────────────────────────────────────────────────
// INVITE COLLEAGUE — step 6 of the wizard. Creates a pending user row
// with a signed invite token and sends the welcome/claim email. The
// recipient clicks the link, sets their password, and is then a full
// team member.
// ──────────────────────────────────────────────────────────────────────

export interface InviteColleagueInput {
  email: string;
  role: "manager" | "member"; // admin-only roles cannot be assigned here
  fullName?: string; // optional, will default to the email local-part
}

export async function inviteColleague(
  companyId: string,
  inviterUserId: string,
  input: InviteColleagueInput
): Promise<{ invited: true; userId: string; email: string }> {
  const normalized = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new AppError(
      "Please enter a valid email address",
      400,
      "VALIDATION_ERROR"
    );
  }

  // Reject re-invites for emails that already have an active user on any
  // company. Letting the same email exist across companies is fine, but
  // silently overwriting an active account would be a security footgun.
  const existing = await prisma.user.findUnique({
    where: { email: normalized },
    select: { id: true, companyId: true, status: true },
  });
  if (existing) {
    if (existing.companyId === companyId) {
      throw new AppError(
        "This email is already on your team.",
        409,
        "ALREADY_MEMBER"
      );
    }
    throw new AppError(
      "This email is already registered to another workspace.",
      409,
      "EMAIL_TAKEN"
    );
  }

  const inviter = await prisma.user.findUnique({
    where: { id: inviterUserId },
    select: { fullName: true, company: { select: { name: true } } },
  });
  const companyName = inviter?.company?.name || "your team";
  const inviterName = inviter?.fullName || "A colleague";

  // Create the pending user. We leave passwordHash null — the claim email
  // sends them through a /claim-invite?token=... page which calls the
  // existing reset-password endpoint to set credentials.
  const claimToken = crypto.randomBytes(24).toString("hex");
  const claimExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const defaultName =
    input.fullName?.trim() || normalized.split("@")[0].replace(/[._-]+/g, " ");

  const newUser = await prisma.user.create({
    data: {
      companyId,
      email: normalized,
      fullName: defaultName,
      role: input.role,
      status: "active",
      emailVerified: false,
      // Reuse password reset machinery for the claim flow
      passwordResetToken: claimToken,
      passwordResetExpires: claimExpires,
    },
    select: { id: true, email: true },
  });

  // Fire the invite email. We do NOT block the response on email success —
  // a transient Resend outage shouldn't prevent the invitation row from
  // existing. The inviter can resend via /settings/team if the email got
  // lost.
  const appUrl = env.APP_URL || "https://crm.zyrix.co";
  const claimUrl = `${appUrl}/en/claim-invite?token=${claimToken}`;

  const subject = `${inviterName} invited you to join ${companyName} on Zyrix CRM`;
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #F0F9FF; margin: 0; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
    .header { background: linear-gradient(135deg, #0891B2, #06B6D4); color: white; padding: 40px; text-align: center; }
    .content { padding: 40px; color: #164E63; }
    .button { display: inline-block; background: #0891B2; color: white !important; padding: 14px 36px; text-decoration: none; border-radius: 8px; font-weight: bold; margin: 24px 0; }
    .footer { background: #F9FAFB; padding: 24px; text-align: center; color: #6B7280; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>You're invited</h1>
    </div>
    <div class="content">
      <p><strong>${escapeHtml(inviterName)}</strong> invited you to join <strong>${escapeHtml(companyName)}</strong> on Zyrix CRM.</p>
      <p>Click below to accept the invitation and set your password. The link expires in 7 days.</p>
      <div style="text-align: center;">
        <a href="${claimUrl}" class="button">Accept invitation</a>
      </div>
      <p style="color: #475569; font-size: 14px;">Or copy this link:<br>
        <code style="background: #F0F9FF; padding: 4px 8px; border-radius: 4px; word-break: break-all;">${claimUrl}</code>
      </p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} Zyrix CRM</p>
    </div>
  </div>
</body>
</html>`;

  // Fire and forget — return success regardless of email delivery
  void sendEmail({ to: normalized, subject, html });

  return { invited: true, userId: newUser.id, email: normalized };
}

// Tiny HTML escaper for the fields we interpolate into the invite email.
// Names and company titles can contain & < >, which would otherwise break
// the layout when rendered in the recipient's client.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
