import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import * as Planned from "../services/planned-spend.service";

// ============================================================================
// PLANNED SPEND CONTROLLER (/api/cac/planned, session auth) — CAC Sprint 2 (P2).
// Read = owner/admin/manager; write = owner/admin only — both enforced on the
// router. Gated by `cac` (ALL_ON). Planned rows feed Sprint-3 forecasting and
// are NEVER read by actual CAC.
// ============================================================================

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId, role: r.user.role };
}

function notFoundRes(res: Response) {
  return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Planned entry not found" } });
}

function handlePlannedError(err: unknown, res: Response, next: NextFunction) {
  if (err instanceof Planned.PlannedValidationError) {
    return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: err.message } });
  }
  next(err);
}

const plannedSchema = z.object({
  periodMonth: z.string().regex(/^\d{4}-\d{2}/, "periodMonth must be YYYY-MM"),
  kind: z.enum(Planned.PLANNED_KINDS),
  // platform (kind=ad) / category (kind=non_ad) — normalized in the service; the
  // irrelevant one is nulled there, so accept any short string here.
  platform: z.string().max(20).nullable().optional(),
  category: z.string().max(20).nullable().optional(),
  label: z.string().max(200).nullable().optional(),
  amount: z.number().nonnegative().max(999999999999),
  currency: z.string().max(8).optional(),
  note: z.string().max(500).nullable().optional(),
});

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await Planned.listPlanned(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const dto = plannedSchema.parse(req.body);
    const data = await Planned.addPlanned(companyId, userId, dto);
    res.status(201).json({ success: true, data });
  } catch (err) { handlePlannedError(err, res, next); }
}

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = plannedSchema.partial().parse(req.body);
    const data = await Planned.updatePlanned(companyId, String(req.params.id), dto);
    if (!data) return notFoundRes(res);
    res.status(200).json({ success: true, data });
  } catch (err) { handlePlannedError(err, res, next); }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const ok = await Planned.deletePlanned(companyId, String(req.params.id));
    if (!ok) return notFoundRes(res);
    res.status(200).json({ success: true });
  } catch (err) { next(err); }
}
