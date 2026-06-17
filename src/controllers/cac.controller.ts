import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types";
import * as Cac from "../services/cac.service";
import * as Forecast from "../services/cac-forecast.service";

// ============================================================================
// CAC CONTROLLER (/api/cac, session auth) — Sprint 1 (CAC Core) + Sprint 3
// (forecast + recommendations). Read = owner/admin/manager (cost data; enforced
// on the router). Gated by the `cac` entitlement (ALL_ON).
// ============================================================================

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId, role: r.user.role };
}

function localeOf(req: Request): "en" | "ar" | "tr" {
  const l = String(req.query.locale || "").toLowerCase();
  return l === "ar" || l === "tr" ? l : "en";
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

// Sprint 3 — next-month forecast from trailing conversion efficiency × planned
// spend. Read-only consumer of computeMonthlyCac + listPlanned (?window=3|6|all).
export async function forecast(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const window = Forecast.parseWindow(req.query.window);
    const data = await Forecast.computeCacForecast(companyId, window);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// Sprint 3 — rule-based recommendations: benchmark comparison + data-triggered
// levers + sourced playbook (?window=3|6|all, ?locale=en|ar|tr).
export async function recommendations(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const window = Forecast.parseWindow(req.query.window);
    const data = await Forecast.computeCacRecommendations(companyId, localeOf(req), window);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
