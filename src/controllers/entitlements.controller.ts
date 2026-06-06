import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types";
import { resolveAll } from "../services/entitlements.service";

// ──────────────────────────────────────────────────────────────────────
// GET /api/entitlements/me
// Returns the authenticated company's resolved entitlement map
// (per feature: { enabled, limit }) + its plan. The web app reads this
// once to gate menus/pages/buttons and to show usage-vs-limit.
// ──────────────────────────────────────────────────────────────────────
export async function me(req: Request, res: Response, next: NextFunction) {
  try {
    const companyId = (req as AuthenticatedRequest).user.companyId;
    const data = await resolveAll(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
