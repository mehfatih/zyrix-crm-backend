import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import * as BillingSvc from "../services/billing.service";
import * as PlanReqSvc from "../services/plan-requests.service";
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
    const { userId, companyId } = auth(req);
    const id = req.params.id as string;
    // Authz enforced by requirePermission('settings:billing') on the route.
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
    const { userId, companyId } = auth(req);
    const id = req.params.id as string;
    // Authz enforced by requirePermission('settings:billing') on the route.
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

// ──────────────────────────────────────────────────────────────────────
// Sprint 16D — in-app plan change requests (tenant side)
// ──────────────────────────────────────────────────────────────────────

const planRequestSchema = z.object({
  requestedPlan: z.enum(["free", "starter", "business", "enterprise"]),
  note: z.string().max(1000).optional(),
});

export async function planRequest(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, companyId } = auth(req);
    const dto = planRequestSchema.parse(req.body);
    const data = await PlanReqSvc.createOrUpdateRequest(
      companyId,
      userId,
      dto.requestedPlan,
      dto.note
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function currentPlanRequest(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await PlanReqSvc.getCurrentRequest(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function cancelPlanRequest(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await PlanReqSvc.cancelRequest(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
