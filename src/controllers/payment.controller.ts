import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import {
  createCheckoutSession,
  processWebhook,
  confirmStubPayment,
} from "../services/payment.service";

// ============================================================================
// PAYMENT CONTROLLER
// ============================================================================

const createCheckoutSchema = z.object({
  companyId: z.string().min(1),
  planSlug: z.string().min(1),
  billingCycle: z.enum(["monthly", "yearly"]),
  currency: z.enum(["USD", "TRY", "SAR", "AED"]),
  buyerCountry: z.string().optional(),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

const confirmStubSchema = z.object({
  clientReference: z.string().min(1),
});

export async function createCheckout(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const dto = createCheckoutSchema.parse(req.body);
    const buyerIp =
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
      req.socket.remoteAddress ??
      undefined;
    const result = await createCheckoutSession({
      ...dto,
      buyerIp,
    } as Parameters<typeof createCheckoutSession>[0]);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function iyzicoWebhook(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers[k.toLowerCase()] = v;
    }
    const result = await processWebhook("iyzico", req.body, headers);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function hyperpayWebhook(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers[k.toLowerCase()] = v;
    }
    const result = await processWebhook("hyperpay", req.body, headers);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function confirmStub(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { clientReference } = confirmStubSchema.parse(req.body);
    const result = await confirmStubPayment(clientReference);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
