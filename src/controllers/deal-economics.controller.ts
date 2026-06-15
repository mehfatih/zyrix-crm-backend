import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as economics from "../services/deal-economics.service";
import type { AuthenticatedRequest } from "../types";
import { badRequest, notFound } from "../middleware/errorHandler";

const costsSchema = z
  .object({
    shipping: z.number().nonnegative().optional(),
    paymentFee: z.number().nonnegative().optional(),
    adSpend: z.number().nonnegative().optional(),
    other: z.number().nonnegative().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, {
    message: "Provide at least one cost field",
  });

function getDealId(req: Request): string {
  const value = req.params.id;
  if (!value) throw badRequest("Missing parameter: id");
  return Array.isArray(value) ? value[0] : value;
}

// GET /api/deals/:id/economics — read-time profitability breakdown.
export async function getEconomics(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const data = await economics.computeDealEconomics(
      authReq.user.companyId,
      getDealId(req)
    );
    if (!data) throw notFound("Deal");
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

// PATCH /api/deals/:id/economics/costs — update variable costs (base currency).
export async function updateCosts(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const dto = costsSchema.parse(req.body);
    const data = await economics.updateVariableCosts(
      authReq.user.companyId,
      getDealId(req),
      dto
    );
    if (!data) throw notFound("Deal");
    res.json({ success: true, data, message: "Costs updated" });
  } catch (error) {
    next(error);
  }
}

// POST /api/deals/:id/economics/recompute — re-stamp COGS / first-stamp legacy
// won deals. Keeps the frozen FX rate + base revenue untouched.
export async function recompute(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const data = await economics.recomputeDealEconomics(
      authReq.user.companyId,
      getDealId(req)
    );
    if (!data) throw notFound("Deal");
    res.json({ success: true, data, message: "Economics recomputed" });
  } catch (error) {
    next(error);
  }
}
