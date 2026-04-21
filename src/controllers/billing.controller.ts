import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import * as BillingSvc from "../services/billing.service";
import { recordAudit, extractRequestMeta } from "../utils/audit";

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId, role: r.user.role };
}

// ──────────────────────────────────────────────────────────────────────
// GET /plans — public plan catalog (but we still auth to keep callers
// consistent; the body is the same for everyone).
// ──────────────────────────────────────────────────────────────────────

export async function listPlans(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const data = await BillingSvc.listAvailablePlans();
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function currentBilling(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await BillingSvc.getCurrentBilling(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

const invoicesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

export async function listInvoices(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const q = invoicesQuerySchema.parse(req.query);
    const data = await BillingSvc.listInvoices(companyId, q.limit, q.offset);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function cancel(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId, role } = auth(req);
    const id = req.params.id as string;
    // Only owners/admins can cancel billing — member/manager shouldn't
    // accidentally downgrade the company.
    if (role !== "owner" && role !== "admin") {
      return res.status(403).json({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: "Only owners and admins can cancel the subscription.",
        },
      });
    }
    const data = await BillingSvc.cancelSubscription(companyId, id);
    await recordAudit({
      userId,
      companyId,
      action: "billing.subscription_cancelled",
      entityType: "subscription",
      entityId: id,
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function resume(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId, role } = auth(req);
    const id = req.params.id as string;
    if (role !== "owner" && role !== "admin") {
      return res.status(403).json({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: "Only owners and admins can modify the subscription.",
        },
      });
    }
    const data = await BillingSvc.resumeSubscription(companyId, id);
    await recordAudit({
      userId,
      companyId,
      action: "billing.subscription_resumed",
      entityType: "subscription",
      entityId: id,
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
