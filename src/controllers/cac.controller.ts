import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types";
import * as Cac from "../services/cac.service";

// ============================================================================
// CAC CONTROLLER (/api/cac, session auth) — Sprint 1 (CAC Core).
// Read = owner/admin/manager (cost data; enforced on the router). Gated by the
// `cac` entitlement (ALL_ON).
// ============================================================================

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId, role: r.user.role };
}

export async function monthly(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const months = Number(req.query.months);
    const data = await Cac.computeMonthlyCac(companyId, Number.isFinite(months) ? months : 12);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
