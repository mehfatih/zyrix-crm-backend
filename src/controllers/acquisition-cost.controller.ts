import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import * as Cost from "../services/acquisition-cost.service";

// ============================================================================
// ACQUISITION COSTS CONTROLLER (/api/cac/costs, session auth) — CAC Sprint 2.
// Read = owner/admin/manager; write = owner/admin only (salaries/commissions are
// sensitive) — both enforced on the router. Gated by `cac` (ALL_ON).
// ============================================================================

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId, role: r.user.role };
}

function notFoundRes(res: Response) {
  return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Cost not found" } });
}

function handleCostError(err: unknown, res: Response, next: NextFunction) {
  if (err instanceof Cost.CostValidationError) {
    return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: err.message } });
  }
  next(err);
}

const costSchema = z.object({
  costDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/, "costDate must be YYYY-MM-DD"),
  category: z.enum(Cost.COST_CATEGORIES),
  // channel is an optional ad-platform tag; blank/garbage → null (non_ad bucket),
  // normalized in the service, so accept any short string here.
  channel: z.string().max(20).nullable().optional(),
  amount: z.number().nonnegative().max(999999999999),
  currency: z.string().max(8).optional(),
  note: z.string().max(500).nullable().optional(),
});

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await Cost.listCosts(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const dto = costSchema.parse(req.body);
    const data = await Cost.addCost(companyId, userId, dto);
    res.status(201).json({ success: true, data });
  } catch (err) { handleCostError(err, res, next); }
}

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = costSchema.partial().parse(req.body);
    const data = await Cost.updateCost(companyId, String(req.params.id), dto);
    if (!data) return notFoundRes(res);
    res.status(200).json({ success: true, data });
  } catch (err) { handleCostError(err, res, next); }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const ok = await Cost.deleteCost(companyId, String(req.params.id));
    if (!ok) return notFoundRes(res);
    res.status(200).json({ success: true });
  } catch (err) { next(err); }
}
