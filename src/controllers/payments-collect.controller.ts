import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import { env } from "../config/env";
import {
  connectProvider, listConnections, disconnectProvider, createQuoteCollectRequest,
  getRequest, verifyAndMark,
} from "../services/payments-collect.service";
import { hyperpayWidgetBase } from "../services/payments-collect/gateways";
import { prisma } from "../config/database";

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}
function appBase(): string {
  return (env.APP_URL || "https://crm.zyrix.co").replace(/\/$/, "");
}

const connectSchema = z.object({
  provider: z.enum(["iyzico", "hyperpay"]),
  currency: z.string().min(3).max(3),
  sandbox: z.boolean().optional(),
  keys: z.record(z.string()),
});

export async function connect(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = connectSchema.parse(req.body);
    const data = await connectProvider(companyId, dto.provider, dto.keys as any, dto.currency, dto.sandbox !== false);
    res.status(201).json({ success: true, data });
  } catch (e) { next(e); }
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    res.json({ success: true, data: await listConnections(companyId) });
  } catch (e) { next(e); }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    await disconnectProvider(companyId, String(req.params.provider));
    res.json({ success: true, data: { deleted: true } });
  } catch (e) { next(e); }
}

// Authenticated: generate a collect link for a quote (sent via email/WhatsApp).
export async function collectForQuote(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await createQuoteCollectRequest(companyId, String(req.params.id));
    res.json({ success: true, data });
  } catch (e) { next(e); }
}

// ── Public gateway callbacks ─────────────────────────────────────────────────
function quoteRedirect(quoteId: string | null, status: string): string {
  // Best-effort: send the customer back to a thank-you/quote view.
  return `${appBase()}/en/pay/${status}${quoteId ? `?quote=${quoteId}` : ""}`;
}

// iyzico CheckoutForm POSTs the customer's browser here with a token.
export async function iyzicoCallback(req: Request, res: Response) {
  const requestId = String(req.params.requestId);
  try {
    const r = await verifyAndMark(requestId);
    const reqRow = await getRequest(requestId);
    res.redirect(quoteRedirect(reqRow?.quoteId ?? null, r.paid ? "success" : "failed"));
  } catch {
    res.redirect(quoteRedirect(null, "failed"));
  }
}

// HyperPay Copy&Pay — serve the page that embeds the OPPWA widget.
export async function hyperpayPage(req: Request, res: Response) {
  const requestId = String(req.params.requestId);
  const reqRow = await getRequest(requestId);
  if (!reqRow || !reqRow.externalId) {
    res.status(404).send("Payment not found");
    return;
  }
  const conn = await prisma.paymentConnection.findFirst({ where: { companyId: reqRow.companyId, provider: "hyperpay" }, select: { sandbox: true } });
  const base = hyperpayWidgetBase(conn?.sandbox !== false);
  const resultUrl = `${(env.EMAIL_TRACKING_BASE_URL || "https://api.crm.zyrix.co").replace(/\/$/, "")}/api/public/pay/hyperpay/${requestId}/result`;
  const brands = reqRow.currency === "AED" ? "VISA MASTER" : "VISA MASTER MADA";
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payment</title><script src="${base}/v1/paymentWidgets.js?checkoutId=${encodeURIComponent(reqRow.externalId)}"></script></head>
<body style="font-family:system-ui;max-width:480px;margin:24px auto;padding:0 16px">
<h3>Pay ${Number(reqRow.amount).toFixed(2)} ${reqRow.currency}</h3>
<form action="${resultUrl}" class="paymentWidgets" data-brands="${brands}"></form>
</body></html>`);
}

// HyperPay shopperResultUrl — query status, mark paid, redirect.
export async function hyperpayResult(req: Request, res: Response) {
  const requestId = String(req.params.requestId);
  try {
    const r = await verifyAndMark(requestId);
    const reqRow = await getRequest(requestId);
    res.redirect(quoteRedirect(reqRow?.quoteId ?? null, r.paid ? "success" : "failed"));
  } catch {
    res.redirect(quoteRedirect(null, "failed"));
  }
}
