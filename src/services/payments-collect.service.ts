// ============================================================================
// PAYMENT COLLECTION (Sprint 15E) — per-company merchant payments on quotes.
// ----------------------------------------------------------------------------
// Connect iyzico (TRY) / HyperPay (SAR, AED) with per-company keys (tokenCipher-
// sealed, sandbox-first); generate a checkout link for a quote; mark paid on
// gateway callback/verify and fire payment.succeeded. Distinct from platform
// subscription billing (untouched).
// ============================================================================

import { prisma } from "../config/database";
import { env } from "../config/env";
import { badRequest, notFound } from "../middleware/errorHandler";
import { encryptToken, decryptToken, type SealedToken } from "../lib/crypto/tokenCipher";
import { dispatchPaymentSucceeded } from "./workflow-events.service";
import {
  iyzicoInitialize, iyzicoVerify, hyperpayInitialize, hyperpayVerify,
  type CollectProvider, type IyzicoKeys, type HyperPayKeys,
} from "./payments-collect/gateways";

const PROVIDER_CURRENCIES: Record<CollectProvider, string[]> = {
  iyzico: ["TRY"],
  hyperpay: ["SAR", "AED"],
};

function apiBase(): string {
  return (env.EMAIL_TRACKING_BASE_URL || "https://api.crm.zyrix.co").replace(/\/$/, "");
}
function seal(plaintext: string): string {
  return JSON.stringify(encryptToken(plaintext));
}
function unseal(text: string): string {
  return decryptToken(JSON.parse(text) as SealedToken);
}

// ── Connections ──────────────────────────────────────────────────────────────
export async function connectProvider(
  companyId: string,
  provider: CollectProvider,
  keys: IyzicoKeys | HyperPayKeys,
  currency: string,
  sandbox: boolean
): Promise<{ provider: string; currency: string; sandbox: boolean }> {
  const cur = currency.toUpperCase();
  if (!PROVIDER_CURRENCIES[provider]?.includes(cur)) {
    throw badRequest(`${provider} does not support ${cur}. Allowed: ${PROVIDER_CURRENCIES[provider].join(", ")}`);
  }
  await prisma.paymentConnection.upsert({
    where: { companyId_provider: { companyId, provider } },
    create: { companyId, provider, currency: cur, sandbox, sealedKeys: seal(JSON.stringify(keys)), status: "active" },
    update: { currency: cur, sandbox, sealedKeys: seal(JSON.stringify(keys)), status: "active" },
  });
  return { provider, currency: cur, sandbox };
}

export async function listConnections(companyId: string) {
  const rows = await prisma.paymentConnection.findMany({
    where: { companyId },
    select: { id: true, provider: true, currency: true, sandbox: true, status: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  return rows;
}

export async function disconnectProvider(companyId: string, provider: string): Promise<void> {
  await prisma.paymentConnection.deleteMany({ where: { companyId, provider } });
}

async function getConnectionForCurrency(companyId: string, currency: string) {
  const cur = currency.toUpperCase();
  const conns = await prisma.paymentConnection.findMany({ where: { companyId, status: "active", currency: cur } });
  return conns[0] ?? null;
}

// ── Create a collect request for a quote ─────────────────────────────────────
export async function createQuoteCollectRequest(companyId: string, quoteId: string) {
  const quote = await prisma.quote.findFirst({
    where: { id: quoteId, companyId },
    include: { customer: { select: { fullName: true, email: true, country: true } } },
  });
  if (!quote) throw notFound("Quote");
  const currency = quote.currency.toUpperCase();
  const amount = Number(quote.total);
  if (!(amount > 0)) throw badRequest("Quote total must be greater than zero");

  const conn = await getConnectionForCurrency(companyId, currency);
  if (!conn) throw badRequest(`No payment method connected for ${currency}. Connect iyzico (TRY) or HyperPay (SAR/AED) in Settings → Payments.`);

  // Reuse an existing pending request for this quote if present.
  const existing = await prisma.paymentRequest.findFirst({ where: { companyId, quoteId, status: "pending" } });
  const reqRow = existing ?? await prisma.paymentRequest.create({
    data: { companyId, provider: conn.provider, quoteId, amount, currency, status: "pending" },
  });

  const keys = JSON.parse(unseal(conn.sealedKeys));
  const buyer = {
    buyerEmail: quote.customer?.email || "buyer@example.com",
    buyerName: quote.customer?.fullName || "Customer",
    buyerCountry: quote.customer?.country || undefined,
  };

  let externalId = reqRow.externalId;
  let checkoutUrl = reqRow.checkoutUrl;
  if (!externalId || !checkoutUrl) {
    if (conn.provider === "iyzico") {
      const r = await iyzicoInitialize(keys as IyzicoKeys, conn.sandbox, {
        amount, currency, conversationId: reqRow.id, callbackUrl: `${apiBase()}/api/public/pay/iyzico/${reqRow.id}/callback`, ...buyer,
      });
      externalId = r.externalId; checkoutUrl = r.checkoutUrl;
    } else {
      const r = await hyperpayInitialize(keys as HyperPayKeys, conn.sandbox, {
        amount, currency, conversationId: reqRow.id, callbackUrl: `${apiBase()}/api/public/pay/hyperpay/${reqRow.id}`, ...buyer,
      });
      externalId = r.externalId; checkoutUrl = r.checkoutUrl;
    }
    await prisma.paymentRequest.update({ where: { id: reqRow.id }, data: { externalId, checkoutUrl } });
  }
  return { id: reqRow.id, provider: conn.provider, amount, currency, checkoutUrl: checkoutUrl!, status: reqRow.status };
}

// ── Mark paid (idempotent) + fire automation ─────────────────────────────────
export async function markRequestPaid(requestId: string, raw: unknown): Promise<boolean> {
  const reqRow = await prisma.paymentRequest.findUnique({ where: { id: requestId } });
  if (!reqRow) return false;
  if (reqRow.status === "paid") return true; // idempotent

  const events = Array.isArray(reqRow.events) ? (reqRow.events as unknown[]) : [];
  await prisma.paymentRequest.update({
    where: { id: requestId },
    data: { status: "paid", paidAt: new Date(), events: [...events, { at: new Date().toISOString(), type: "paid" }] as any },
  });
  void dispatchPaymentSucceeded(reqRow.companyId, {
    amount: Number(reqRow.amount), currency: reqRow.currency, provider: reqRow.provider, quoteId: reqRow.quoteId,
  });
  // Best-effort: when the paid request is tied to a quote, mark it accepted.
  if (reqRow.quoteId) {
    await prisma.quote.updateMany({ where: { id: reqRow.quoteId, status: { notIn: ["accepted", "rejected"] } }, data: { status: "accepted" } }).catch(() => {});
  }
  void raw;
  return true;
}

// Verify a request against the gateway, then mark paid if confirmed.
export async function verifyAndMark(requestId: string): Promise<{ paid: boolean }> {
  const reqRow = await prisma.paymentRequest.findUnique({ where: { id: requestId } });
  if (!reqRow || !reqRow.externalId) return { paid: false };
  if (reqRow.status === "paid") return { paid: true };
  const conn = await prisma.paymentConnection.findFirst({ where: { companyId: reqRow.companyId, provider: reqRow.provider } });
  if (!conn) return { paid: false };
  const keys = JSON.parse(unseal(conn.sealedKeys));
  const v = reqRow.provider === "iyzico"
    ? await iyzicoVerify(keys, conn.sandbox, reqRow.externalId)
    : await hyperpayVerify(keys, conn.sandbox, reqRow.externalId);
  if (v.paid) await markRequestPaid(requestId, v.raw);
  return { paid: v.paid };
}

export async function getRequest(requestId: string) {
  return prisma.paymentRequest.findUnique({ where: { id: requestId } });
}

// For the public quote page: does this quote have a usable connection + link?
export async function quotePayability(companyId: string, quoteId: string, currency: string) {
  const conn = await getConnectionForCurrency(companyId, currency);
  return { payable: !!conn, provider: conn?.provider ?? null };
}
