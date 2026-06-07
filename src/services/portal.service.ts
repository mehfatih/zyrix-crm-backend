import { prisma } from "../config/database";
import { badRequest, notFound } from "../middleware/errorHandler";
import { randomBytes } from "crypto";
import { sendEmail } from "./email.service";
import { ensureTicketForInbound, logEvent } from "./ticket.service";
import { countPublished } from "./kb.service";
import { isFeatureEnabled } from "./feature-flags.service";
import { createQuoteCollectRequest } from "./payments-collect.service";

// Quote statuses that are eligible for a portal "Pay now" (already sent to the
// customer + not closed/dead). Mirrors the public quote pay surface.
const PAYABLE_QUOTE_STATUSES = ["sent", "viewed", "accepted"];

// ============================================================================
// CUSTOMER PORTAL SERVICE
// ============================================================================

const LOGIN_TOKEN_TTL_MIN = 15;
const SESSION_TOKEN_TTL_DAYS = 30;

function genToken(): string {
  return randomBytes(32).toString("hex");
}

// ─────────────────────────────────────────────────────────────────────────
// ISSUE MAGIC LINK (sends email with login URL)
// ─────────────────────────────────────────────────────────────────────────
export async function issueMagicLink(
  email: string,
  portalBaseUrl: string
): Promise<{ delivered: boolean; customerFound: boolean }> {
  const customer = await prisma.customer.findFirst({
    where: { email: email.toLowerCase().trim() },
    include: { company: { select: { id: true, name: true } } },
  });

  // Silent-success: don't reveal whether email exists
  if (!customer) {
    return { delivered: false, customerFound: false };
  }

  const token = genToken();
  const expiresAt = new Date(
    Date.now() + LOGIN_TOKEN_TTL_MIN * 60 * 1000
  );

  await prisma.portalToken.create({
    data: {
      customerId: customer.id,
      companyId: customer.companyId,
      token,
      purpose: "login",
      expiresAt,
    },
  });

  const magicUrl = `${portalBaseUrl.replace(/\/$/, "")}?token=${token}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 560px; color: #0F172A; padding: 24px;">
      <h2 style="color: #0891B2; margin: 0 0 12px;">Sign in to your portal</h2>
      <p style="font-size: 15px; color: #475569;">
        Hi ${escapeHtml(customer.fullName)},
      </p>
      <p style="font-size: 15px; color: #475569;">
        Click the button below to access your account with ${escapeHtml(customer.company.name)}.
        This link expires in ${LOGIN_TOKEN_TTL_MIN} minutes.
      </p>
      <div style="margin: 24px 0;">
        <a href="${magicUrl}" style="display: inline-block; background: #0891B2; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">
          Access my portal
        </a>
      </div>
      <p style="font-size: 12px; color: #94A3B8;">
        If you didn't request this, you can safely ignore this email.
      </p>
    </div>
  `;

  const delivered = await sendEmail({
    to: customer.email!,
    subject: `Your sign-in link — ${customer.company.name}`,
    html,
    text: `Sign in to your portal: ${magicUrl}\nThis link expires in ${LOGIN_TOKEN_TTL_MIN} minutes.`,
  });

  return { delivered, customerFound: true };
}

// ─────────────────────────────────────────────────────────────────────────
// VERIFY MAGIC TOKEN → returns session token
// ─────────────────────────────────────────────────────────────────────────
export async function verifyMagicToken(
  token: string,
  ipAddress?: string,
  userAgent?: string
): Promise<{ sessionToken: string; customer: any }> {
  const record = await prisma.portalToken.findUnique({
    where: { token },
    include: {
      customer: {
        select: {
          id: true,
          fullName: true,
          email: true,
          companyName: true,
          companyId: true,
          company: { select: { id: true, name: true } },
        },
      },
    },
  });

  if (!record) {
    const err: any = new Error("Invalid token");
    err.statusCode = 401;
    throw err;
  }
  if (record.purpose !== "login") {
    const err: any = new Error("Invalid token type");
    err.statusCode = 401;
    throw err;
  }
  if (record.usedAt) {
    const err: any = new Error("Token already used");
    err.statusCode = 401;
    throw err;
  }
  if (record.expiresAt < new Date()) {
    const err: any = new Error("Token expired");
    err.statusCode = 401;
    throw err;
  }

  // Mark login token used
  await prisma.portalToken.update({
    where: { id: record.id },
    data: { usedAt: new Date(), ipAddress, userAgent },
  });

  // Issue a session token (longer-lived)
  const sessionToken = genToken();
  const sessionExpires = new Date(
    Date.now() + SESSION_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000
  );
  await prisma.portalToken.create({
    data: {
      customerId: record.customerId,
      companyId: record.companyId,
      token: sessionToken,
      purpose: "session",
      expiresAt: sessionExpires,
      ipAddress,
      userAgent,
    },
  });

  return { sessionToken, customer: record.customer };
}

// ─────────────────────────────────────────────────────────────────────────
// RESOLVE SESSION TOKEN → customer
// ─────────────────────────────────────────────────────────────────────────
export async function resolveSession(token: string) {
  const record = await prisma.portalToken.findUnique({
    where: { token },
    include: {
      customer: {
        select: {
          id: true,
          fullName: true,
          email: true,
          companyName: true,
          companyId: true,
          phone: true,
          company: { select: { id: true, name: true } },
        },
      },
    },
  });
  if (!record || record.purpose !== "session") {
    const err: any = new Error("Invalid session");
    err.statusCode = 401;
    throw err;
  }
  if (record.expiresAt < new Date()) {
    const err: any = new Error("Session expired");
    err.statusCode = 401;
    throw err;
  }
  return record.customer;
}

export async function logout(token: string) {
  try {
    await prisma.portalToken.delete({ where: { token } });
  } catch {
    /* no-op */
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────
// SUPPORT — customer raises a request from the portal → service desk ticket
// (inert unless the merchant has the service desk enabled)
// ─────────────────────────────────────────────────────────────────────────
export async function createPortalRequest(
  customer: { id: string; companyId: string },
  subject: string,
  body: string
): Promise<{ created: boolean; ticketId: string | null }> {
  const ticketId = await ensureTicketForInbound({
    companyId: customer.companyId,
    channel: "portal",
    customerId: customer.id,
    subject,
  });
  if (!ticketId) return { created: false, ticketId: null };
  // Record the customer's message text on the ticket timeline.
  await logEvent(customer.companyId, ticketId, "reply_in", {
    metadata: { channel: "portal", body: body.slice(0, 5000) },
  });
  return { created: true, ticketId };
}

// ─────────────────────────────────────────────────────────────────────────
// DATA ACCESS — customer's own records
// ─────────────────────────────────────────────────────────────────────────
export async function getCustomerDashboard(customerId: string) {
  const [customer, quotes, contracts, loyalty] = await Promise.all([
    prisma.customer.findUnique({
      where: { id: customerId },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        companyName: true,
        lifetimeValue: true,
        company: { select: { id: true, name: true } },
      },
    }),
    prisma.quote.findMany({
      where: { customerId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        quoteNumber: true,
        title: true,
        status: true,
        total: true,
        currency: true,
        validUntil: true,
        issuedAt: true,
        publicToken: true,
      },
    }),
    prisma.contract.findMany({
      where: { customerId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        contractNumber: true,
        title: true,
        status: true,
        value: true,
        currency: true,
        startDate: true,
        endDate: true,
        fileUrl: true,
      },
    }),
    prisma.loyaltyTransaction.aggregate({
      where: { customerId },
      _sum: { points: true },
    }),
  ]);

  if (!customer) throw notFound("Customer");

  const companyId = customer.company.id;
  const helpArticles = await countPublished(companyId);
  const quotesWithPay = await enrichQuotesWithPayments(companyId, quotes);

  return {
    customer,
    quotes: quotesWithPay,
    contracts,
    loyaltyBalance: loyalty._sum.points ?? 0,
    helpAvailable: helpArticles > 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// PORTAL PAYMENTS (Sprint 22) — surface Pay-now eligibility + receipts on the
// customer's quotes, and create a checkout request scoped to the portal session.
// Reuses the Sprint-15E payments-collect rails (createQuoteCollectRequest) — no
// new payment path; the platform subscription-billing path is untouched.
// ─────────────────────────────────────────────────────────────────────────

type DashboardQuote = {
  id: string;
  status: string;
  total: unknown;
  currency: string;
};

type QuotePayment = {
  provider: string;
  amount: number;
  currency: string;
  paidAt: string | null;
} | null;

async function portalPaymentsActive(companyId: string): Promise<boolean> {
  // Both must be on: portal_payments gates the portal surface, payments_collect
  // owns the underlying connection/checkout rails.
  return (
    (await isFeatureEnabled(companyId, "portal_payments")) &&
    (await isFeatureEnabled(companyId, "payments_collect"))
  );
}

async function enrichQuotesWithPayments<T extends DashboardQuote>(
  companyId: string,
  quotes: T[]
): Promise<(T & { payable: boolean; payProvider: string | null; payment: QuotePayment })[]> {
  const fallback = quotes.map((q) => ({
    ...q,
    payable: false,
    payProvider: null as string | null,
    payment: null as QuotePayment,
  }));
  try {
    if (quotes.length === 0 || !(await portalPaymentsActive(companyId))) return fallback;

    const [conns, reqs] = await Promise.all([
      prisma.paymentConnection.findMany({
        where: { companyId, status: "active" },
        select: { provider: true, currency: true },
      }),
      prisma.paymentRequest.findMany({
        where: { companyId, quoteId: { in: quotes.map((q) => q.id) } },
        orderBy: { createdAt: "desc" },
        select: { quoteId: true, status: true, amount: true, currency: true, provider: true, paidAt: true },
      }),
    ]);

    const currencyToProvider = new Map<string, string>();
    for (const c of conns) currencyToProvider.set(c.currency.toUpperCase(), c.provider);

    // Latest request per quote (rows already ordered newest-first); a paid one wins.
    const reqByQuote = new Map<string, (typeof reqs)[number]>();
    for (const r of reqs) {
      if (!r.quoteId) continue;
      const existing = reqByQuote.get(r.quoteId);
      if (!existing || (existing.status !== "paid" && r.status === "paid")) {
        reqByQuote.set(r.quoteId, r);
      }
    }

    return quotes.map((q) => {
      const cur = q.currency.toUpperCase();
      const provider = currencyToProvider.get(cur) ?? null;
      const req = reqByQuote.get(q.id);
      const paid = req?.status === "paid";
      const payment: QuotePayment = paid
        ? {
            provider: req!.provider,
            amount: Number(req!.amount),
            currency: req!.currency,
            paidAt: req!.paidAt ? req!.paidAt.toISOString() : null,
          }
        : null;
      const payable =
        !paid &&
        !!provider &&
        PAYABLE_QUOTE_STATUSES.includes(q.status) &&
        Number(q.total) > 0;
      return { ...q, payable, payProvider: payable ? provider : null, payment };
    });
  } catch {
    return fallback; // best-effort: never break the dashboard over payments
  }
}

// Create a checkout request for one of the authenticated customer's own quotes.
export async function payPortalQuote(
  customer: { id: string; companyId: string },
  quoteId: string
) {
  const quote = await prisma.quote.findFirst({
    where: { id: quoteId, customerId: customer.id, companyId: customer.companyId },
    select: { id: true, status: true },
  });
  if (!quote) throw notFound("Quote");
  if (!(await portalPaymentsActive(customer.companyId))) {
    throw badRequest("Payments are not enabled");
  }
  if (!PAYABLE_QUOTE_STATUSES.includes(quote.status)) {
    throw badRequest("This quote is not payable");
  }
  return createQuoteCollectRequest(customer.companyId, quoteId);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
