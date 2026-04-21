// ============================================================================
// BILLING SERVICE
// ----------------------------------------------------------------------------
// Authenticated, company-scoped view onto subscription/plan/payment state.
// Distinct from payment.service.ts which is the unauthenticated checkout +
// webhook plumbing — this is what /settings/billing calls.
// ============================================================================

import { prisma } from "../config/database";
import { AppError, notFound } from "../middleware/errorHandler";

// ──────────────────────────────────────────────────────────────────────
// PLANS — public catalog (same for everyone, so no company scoping)
// ──────────────────────────────────────────────────────────────────────

export async function listAvailablePlans() {
  const plans = await prisma.plan.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      slug: true,
      name: true,
      description: true,
      priceMonthly: true,
      priceYearly: true,
      currency: true,
      features: true,
      isFeatured: true,
      color: true,
    },
  });
  return plans;
}

// ──────────────────────────────────────────────────────────────────────
// CURRENT SUBSCRIPTION — what the merchant is on right now
// ──────────────────────────────────────────────────────────────────────

export async function getCurrentBilling(companyId: string) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: {
      id: true,
      plan: true,
      trialEndsAt: true,
      status: true,
    },
  });
  if (!company) throw notFound("Company not found");

  // Latest non-cancelled subscription — there should only ever be one
  // active at a time, but we order by createdAt so an old cancelled one
  // doesn't win over a new one created after reactivation.
  const subscription = await prisma.subscription.findFirst({
    where: {
      companyId,
      status: { in: ["active", "past_due", "trialing"] },
    },
    orderBy: { createdAt: "desc" },
    include: {
      plan: {
        select: {
          id: true,
          slug: true,
          name: true,
          priceMonthly: true,
          priceYearly: true,
          currency: true,
          features: true,
        },
      },
    },
  });

  return { company, subscription };
}

// ──────────────────────────────────────────────────────────────────────
// INVOICES — historical payments
// ──────────────────────────────────────────────────────────────────────

export async function listInvoices(
  companyId: string,
  limit = 50,
  offset = 0
) {
  const cappedLimit = Math.min(Math.max(limit, 1), 200);
  const cappedOffset = Math.max(offset, 0);

  const [total, items] = await Promise.all([
    prisma.payment.count({ where: { companyId } }),
    prisma.payment.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" },
      take: cappedLimit,
      skip: cappedOffset,
      select: {
        id: true,
        amount: true,
        currency: true,
        status: true,
        gateway: true,
        gatewayPaymentId: true,
        method: true,
        last4: true,
        cardBrand: true,
        description: true,
        failureReason: true,
        paidAt: true,
        refundedAt: true,
        createdAt: true,
        subscription: {
          select: {
            billingCycle: true,
            plan: {
              select: { name: true, slug: true },
            },
          },
        },
      },
    }),
  ]);

  return {
    items,
    pagination: { total, limit: cappedLimit, offset: cappedOffset },
  };
}

// ──────────────────────────────────────────────────────────────────────
// CANCEL — schedules the cancellation at current period end (not immediate)
// so the merchant keeps what they paid for.
// ──────────────────────────────────────────────────────────────────────

export async function cancelSubscription(
  companyId: string,
  subscriptionId: string,
  options: { immediate?: boolean } = {}
) {
  const sub = await prisma.subscription.findFirst({
    where: { id: subscriptionId, companyId },
  });
  if (!sub) throw notFound("Subscription not found");
  if (sub.status === "cancelled") {
    throw new AppError(
      "This subscription is already cancelled.",
      400,
      "ALREADY_CANCELLED"
    );
  }

  if (options.immediate) {
    // Cancel now — downgrade to free immediately. Used for refund flows
    // and support intervention, NOT exposed to the merchant directly
    // (they always get end-of-period cancellation).
    await prisma.$transaction([
      prisma.subscription.update({
        where: { id: sub.id },
        data: {
          status: "cancelled",
          cancelledAt: new Date(),
          cancelAt: new Date(),
        },
      }),
      prisma.company.update({
        where: { id: companyId },
        data: { plan: "free" },
      }),
    ]);
  } else {
    // Schedule at period end — merchant keeps paid access until then,
    // cron or webhook reconciler will downgrade the company.plan when
    // currentPeriodEnd passes.
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { cancelAt: sub.currentPeriodEnd },
    });
  }

  return { cancelled: true, immediate: !!options.immediate };
}

// ──────────────────────────────────────────────────────────────────────
// RESUME — if cancellation was scheduled, unset it.
// ──────────────────────────────────────────────────────────────────────

export async function resumeSubscription(
  companyId: string,
  subscriptionId: string
) {
  const sub = await prisma.subscription.findFirst({
    where: { id: subscriptionId, companyId },
  });
  if (!sub) throw notFound("Subscription not found");
  if (sub.status === "cancelled") {
    throw new AppError(
      "Cancelled subscriptions cannot be resumed — start a new one.",
      400,
      "CANNOT_RESUME_CANCELLED"
    );
  }
  if (!sub.cancelAt) {
    throw new AppError(
      "This subscription is not scheduled for cancellation.",
      400,
      "NOT_SCHEDULED"
    );
  }

  await prisma.subscription.update({
    where: { id: sub.id },
    data: { cancelAt: null },
  });

  return { resumed: true };
}
