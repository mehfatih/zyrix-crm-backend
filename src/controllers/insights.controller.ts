import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types";
import { prisma } from "../config/database";
import {
  getExecutiveSummary,
  getPriorityActions,
  type Locale,
} from "../services/insights.service";

function readLocale(req: Request): Locale {
  const l = String(req.query.locale ?? "en");
  return l === "ar" || l === "tr" ? l : "en";
}

export async function executiveSummary(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const r = req as AuthenticatedRequest;
    // Authoritative display name — first name from the user record.
    const u = await prisma.user.findUnique({
      where: { id: r.user.userId },
      select: { fullName: true },
    });
    const firstName = u?.fullName ? u.fullName.split(" ")[0] : null;
    const data = await getExecutiveSummary(r.user.companyId, firstName, readLocale(req));
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function priorityActions(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const r = req as AuthenticatedRequest;
    const data = await getPriorityActions(r.user.companyId, readLocale(req));
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
