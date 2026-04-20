import { randomUUID } from "crypto";
import { prisma } from "../config/database";
import { env } from "../config/env";
import { badRequest, notFound } from "../middleware/errorHandler";
import { IyzicoGateway } from "./payment-gateways/iyzico.gateway";
import { HyperPayGateway } from "./payment-gateways/hyperpay.gateway";
import type {
  BillingCycle,
  CheckoutSessionInput,
  CheckoutSessionResult,
  PaymentGateway,
  SupportedCurrency,
  WebhookEvent,
} from "./payment-gateways/gateway.interface";
import { sendEmail } from "./email.service";
import type { Prisma } from "@prisma/client";

// ============================================================================
// PAYMENT SERVICE
// ============================================================================
// Orchestrates gateway selection, checkout session creation, and webhook
// processing (creates Subscription + Payment rows and activates companies).
// ============================================================================

// ─────────────────────────────────────────────────────────────────────────
// Gateway routing
// ─────────────────────────────────────────────────────────────────────────
const IYZICO_COUNTRIES = new Set(["TR", "TURKEY"]);
const HYPERPAY_COUNTRIES = new Set([
  "SA",
  "SAUDI ARABIA",
  "KSA",
  "AE",
  "UNITED ARAB EMIRATES",
  "UAE",
  "KW",
  "KUWAIT",
  "QA",
  "QATAR",
  "BH",
  "BAHRAIN",
  "OM",
  "OMAN",
  "EG",
  "EGYPT",
  "IQ",
  "IRAQ",
]);

const iyzico = new IyzicoGateway();
const hyperpay = new HyperPayGateway();

export function pickGateway(country: string | null | undefined): PaymentGateway {
  const key = (country ?? "").trim().toUpperCase();
  if (IYZICO_COUNTRIES.has(key)) return iyzico;
  if (HYPERPAY_COUNTRIES.has(key)) return hyperpay;
  // Default: MENA focus — HyperPay. This keeps SAR customers working even
  // when the country field on the company is blank.
  return hyperpay;
}

export function gatewayByName(name: string): PaymentGateway {
  if (name === "iyzico") return iyzico;
  if (name === "hyperpay") return hyperpay;
  throw badRequest(`Unknown gateway: ${name}`);
}

// ─────────────────────────────────────────────────────────────────────────
// Checkout session creation
// ─────────────────────────────────────────────────────────────────────────
export interface CreateCheckoutDto {
  companyId: string;
  planSlug: string;
  billingCycle: BillingCycle;
  currency: SupportedCurrency;
  buyerCountry?: string;
  buyerIp?: string;
  successUrl?: string;
  cancelUrl?: string;
}

export interface CreateCheckoutResult extends CheckoutSessionResult {
  gateway: "iyzico" | "hyperpay";
  clientReference: string;
  amount: number;
  currency: SupportedCurrency;
}

export async function createCheckoutSession(
  dto: CreateCheckoutDto
): Promise<CreateCheckoutResult> {
  // 1. Load company + plan
  const company = await prisma.company.findUnique({
    where: { id: dto.companyId },
    include: {
      users: {
        where: { role: "owner" },
        take: 1,
        select: { id: true, email: true, fullName: true, phone: true },
      },
    },
  });
  if (!company) throw notFound("Company");

  const plan = await prisma.plan.findUnique({ where: { slug: dto.planSlug } });
  if (!plan) throw notFound("Plan");

  if (plan.slug === "free") {
    throw badRequest("Cannot checkout the Free plan.");
  }

  const owner = company.users[0];
  if (!owner) {
    throw badRequest("Company has no owner user to receive the checkout.");
  }

  // 2. Compute price
  const amount = resolvePlanPrice(plan, dto.billingCycle, dto.currency);
  if (amount <= 0) {
    throw badRequest(
      "This plan has no configured price for the selected currency/cycle."
    );
  }

  // 3. Pick gateway based on country (caller override wins)
  const buyerCountry = dto.buyerCountry ?? company.country ?? "";
  const gateway = pickGateway(buyerCountry);

  // 4. Build input
  const clientReference = `zyr_${randomUUID()}`;
  const successUrl =
    dto.successUrl ?? `${env.FRONTEND_URL}/en/checkout/success`;
  const cancelUrl =
    dto.cancelUrl ?? `${env.FRONTEND_URL}/en/checkout/cancel`;

  const input: CheckoutSessionInput = {
    companyId: company.id,
    planSlug: plan.slug,
    billingCycle: dto.billingCycle,
    currency: dto.currency,
    amount,
    buyerEmail: owner.email,
    buyerFullName: owner.fullName,
    buyerPhone: owner.phone,
    buyerCountry,
    buyerIp: dto.buyerIp,
    successUrl,
    cancelUrl,
    clientReference,
  };

  // 5. Create session at the gateway
  const session = await gateway.createCheckoutSession(input);

  // 6. Record a pending Payment row so we can reconcile on webhook
  await prisma.payment.create({
    data: {
      companyId: company.id,
      amount: amount.toFixed(2),
      currency: dto.currency,
      status: "pending",
      gateway: gateway.name,
      gatewayPaymentId: null,
      gatewayReference: session.gatewaySessionId,
      description: `Checkout for ${plan.slug} (${dto.billingCycle})`,
      metadata: {
        clientReference,
        planSlug: plan.slug,
        billingCycle: dto.billingCycle,
      } as Prisma.InputJsonValue,
    },
  });

  await prisma.auditLog.create({
    data: {
      companyId: company.id,
      action: "payment.checkout_started",
      entityType: "payment",
      metadata: {
        gateway: gateway.name,
        planSlug: plan.slug,
        billingCycle: dto.billingCycle,
        currency: dto.currency,
        amount,
        clientReference,
      } as Prisma.InputJsonValue,
    },
  });

  return {
    ...session,
    gateway: gateway.name,
    clientReference,
    amount,
    currency: dto.currency,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Webhook processing
// ─────────────────────────────────────────────────────────────────────────
export async function processWebhook(
  gatewayName: "iyzico" | "hyperpay",
  rawBody: unknown,
  headers: Record<string, string>
): Promise<{ processed: boolean; paymentId?: string }> {
  const gateway = gatewayByName(gatewayName);
  const event = gateway.parseWebhook(rawBody, headers);

  if (event.type === "unknown" || !event.clientReference) {
    await prisma.auditLog.create({
      data: {
        action: "webhook.received_unknown",
        entityType: "webhook",
        metadata: {
          gateway: gatewayName,
          eventType: event.type,
        } as Prisma.InputJsonValue,
      },
    });
    return { processed: false };
  }

  // Find the pending Payment row we created during checkout session creation
  const pending = await prisma.payment.findFirst({
    where: {
      gateway: gatewayName,
      status: "pending",
      metadata: { path: ["clientReference"], equals: event.clientReference },
    },
  });

  if (!pending) {
    // Idempotency: check whether we already processed this paymentId
    if (event.gatewayPaymentId) {
      const existing = await prisma.payment.findFirst({
        where: { gatewayPaymentId: event.gatewayPaymentId },
      });
      if (existing) return { processed: true, paymentId: existing.id };
    }
    await prisma.auditLog.create({
      data: {
        action: "webhook.no_pending_match",
        entityType: "webhook",
        metadata: {
          gateway: gatewayName,
          clientReference: event.clientReference,
        } as Prisma.InputJsonValue,
      },
    });
    return { processed: false };
  }

  const meta = (pending.metadata ?? {}) as {
    clientReference?: string;
    planSlug?: string;
    billingCycle?: BillingCycle;
  };

  if (event.type === "payment.succeeded") {
    await activateSubscription(pending.id, pending.companyId, meta, event);
    return { processed: true, paymentId: pending.id };
  }

  if (event.type === "payment.failed") {
    await prisma.payment.update({
      where: { id: pending.id },
      data: {
        status: "failed",
        gatewayPaymentId: event.gatewayPaymentId,
        failureReason: event.failureReason ?? "Gateway reported failure",
        last4: event.last4,
        cardBrand: event.cardBrand,
        method: event.method,
      },
    });
    await prisma.auditLog.create({
      data: {
        companyId: pending.companyId,
        action: "payment.failed",
        entityType: "payment",
        entityId: pending.id,
        metadata: {
          gateway: gatewayName,
          reason: event.failureReason,
        } as Prisma.InputJsonValue,
      },
    });
    return { processed: true, paymentId: pending.id };
  }

  if (event.type === "payment.refunded") {
    await prisma.payment.update({
      where: { id: pending.id },
      data: { status: "refunded", refundedAt: new Date() },
    });
    return { processed: true, paymentId: pending.id };
  }

  return { processed: false };
}

// ─────────────────────────────────────────────────────────────────────────
// Dev / QA — manual confirmation (stub mode when no gateway credentials)
// ─────────────────────────────────────────────────────────────────────────
export async function confirmStubPayment(clientReference: string) {
  const pending = await prisma.payment.findFirst({
    where: {
      status: "pending",
      metadata: { path: ["clientReference"], equals: clientReference },
    },
  });
  if (!pending) throw notFound("Pending payment for reference");

  const meta = (pending.metadata ?? {}) as {
    planSlug?: string;
    billingCycle?: BillingCycle;
  };

  await activateSubscription(pending.id, pending.companyId, meta, {
    type: "payment.succeeded",
    raw: { stub: true },
    gatewayPaymentId: `stub_${randomUUID()}`,
    gatewaySessionId: null,
    clientReference,
    amount: Number(pending.amount),
    currency: pending.currency as SupportedCurrency,
    method: "stub",
    last4: "0000",
    cardBrand: "Stub",
    failureReason: null,
  });

  return { activated: true, paymentId: pending.id };
}

// ─────────────────────────────────────────────────────────────────────────
// Internal — activate subscription after successful payment
// ─────────────────────────────────────────────────────────────────────────
async function activateSubscription(
  paymentId: string,
  companyId: string,
  meta: { planSlug?: string; billingCycle?: BillingCycle },
  event: WebhookEvent
): Promise<void> {
  const plan = meta.planSlug
    ? await prisma.plan.findUnique({ where: { slug: meta.planSlug } })
    : null;
  if (!plan) {
    throw badRequest(
      `Cannot activate subscription — plan slug "${meta.planSlug}" not found.`
    );
  }

  const billingCycle: BillingCycle = meta.billingCycle ?? "monthly";
  const amount = Number(event.amount ?? 0);
  const currency = (event.currency ?? "USD") as SupportedCurrency;

  const periodMs =
    billingCycle === "yearly"
      ? 365 * 24 * 60 * 60 * 1000
      : 30 * 24 * 60 * 60 * 1000;
  const now = new Date();
  const periodEnd = new Date(now.getTime() + periodMs);

  await prisma.$transaction(async (tx) => {
    // Cancel any previous active subscription for this company
    await tx.subscription.updateMany({
      where: { companyId, status: "active" },
      data: { status: "cancelled", cancelledAt: now },
    });

    // Create the new subscription
    const sub = await tx.subscription.create({
      data: {
        companyId,
        planId: plan.id,
        status: "active",
        billingCycle,
        currency,
        amount: amount.toFixed(2),
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        gateway: event.raw && typeof event.raw === "object" ? "gateway" : null,
      },
    });

    // Update the payment row
    await tx.payment.update({
      where: { id: paymentId },
      data: {
        status: "succeeded",
        subscriptionId: sub.id,
        gatewayPaymentId: event.gatewayPaymentId,
        paidAt: now,
        method: event.method,
        last4: event.last4,
        cardBrand: event.cardBrand,
      },
    });

    // Upgrade the company
    await tx.company.update({
      where: { id: companyId },
      data: {
        plan: plan.slug,
        status: "active",
        suspendedAt: null,
        suspendReason: null,
      },
    });

    // Audit
    await tx.auditLog.create({
      data: {
        companyId,
        action: "subscription.activated",
        entityType: "subscription",
        entityId: sub.id,
        metadata: {
          planSlug: plan.slug,
          billingCycle,
          amount,
          currency,
        } as Prisma.InputJsonValue,
      },
    });
  });

  // Send receipt email (best-effort)
  await sendReceiptEmail(companyId, plan.slug, amount, currency, billingCycle);
}

async function sendReceiptEmail(
  companyId: string,
  planSlug: string,
  amount: number,
  currency: string,
  billingCycle: BillingCycle
): Promise<void> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    include: {
      users: {
        where: { role: "owner" },
        take: 1,
        select: { email: true, fullName: true },
      },
    },
  });
  if (!company?.users[0]) return;

  const owner = company.users[0];
  const subject = `Welcome to Zyrix ${planSlug} 🎉`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #0F172A;">
      <div style="background: linear-gradient(135deg, #0891B2, #06B6D4); padding: 32px; border-radius: 12px 12px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 22px;">Subscription activated</h1>
      </div>
      <div style="background: #fff; border: 1px solid #BAE6FD; border-top: none; padding: 28px; border-radius: 0 0 12px 12px;">
        <p>Hi ${owner.fullName},</p>
        <p>Your subscription to <strong>Zyrix ${planSlug}</strong> (${billingCycle}) is now active.</p>
        <div style="background: #F0F9FF; padding: 16px; border-radius: 8px; margin: 20px 0; border: 1px solid #BAE6FD;">
          <div style="font-size: 12px; color: #64748B; text-transform: uppercase;">Amount charged</div>
          <div style="font-size: 22px; font-weight: bold; color: #164E63; margin-top: 4px;">${currency} ${amount.toFixed(2)}</div>
          <div style="font-size: 12px; color: #64748B; margin-top: 6px;">Company: ${company.name}</div>
        </div>
        <p>
          <a href="${env.FRONTEND_URL}/en/dashboard" style="display: inline-block; background: #0891B2; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600;">
            Go to dashboard
          </a>
        </p>
        <p style="font-size: 12px; color: #64748B; margin-top: 24px;">
          Thank you for choosing Zyrix. Your next renewal is in ${billingCycle === "yearly" ? "one year" : "30 days"}.
        </p>
      </div>
    </div>
  `;
  await sendEmail({ to: owner.email, subject, html });
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────
function resolvePlanPrice(
  plan: {
    priceMonthlyUsd: Prisma.Decimal | number | string;
    priceYearlyUsd: Prisma.Decimal | number | string;
    priceMonthlyTry: Prisma.Decimal | number | string;
    priceYearlyTry: Prisma.Decimal | number | string;
    priceMonthlySar: Prisma.Decimal | number | string;
    priceYearlySar: Prisma.Decimal | number | string;
  },
  cycle: BillingCycle,
  currency: SupportedCurrency
): number {
  const k = (
    {
      USD: cycle === "monthly" ? "priceMonthlyUsd" : "priceYearlyUsd",
      TRY: cycle === "monthly" ? "priceMonthlyTry" : "priceYearlyTry",
      SAR: cycle === "monthly" ? "priceMonthlySar" : "priceYearlySar",
      // HyperPay supports AED too — we reuse USD price for now as a minimum
      AED: cycle === "monthly" ? "priceMonthlyUsd" : "priceYearlyUsd",
    } as const
  )[currency];
  const v = (plan as Record<string, unknown>)[k];
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") return parseFloat(v);
  // Prisma Decimal
  return parseFloat(String(v));
}
