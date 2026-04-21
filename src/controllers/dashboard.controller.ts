import type { Request, Response, NextFunction } from "express";
import * as DashboardSvc from "../services/dashboard.service";
import type { AuthenticatedRequest } from "../types";

export async function getStats(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const r = req as AuthenticatedRequest;
    const data = await DashboardSvc.getDashboardStats(
      r.user.companyId,
      r.user.userId,
      r.user.role as DashboardSvc.UserRole
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
