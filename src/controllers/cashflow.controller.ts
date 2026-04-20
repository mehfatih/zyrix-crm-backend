import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as CashFlowSvc from "../services/cashflow.service";
import type { AuthenticatedRequest } from "../types";

const forecastQuerySchema = z.object({
  horizon: z
    .enum(["30", "60", "90"])
    .transform((v) => Number(v) as 30 | 60 | 90)
    .optional(),
  currency: z.string().min(2).max(8).optional(),
});

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

export async function forecast(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const q = forecastQuerySchema.parse(req.query);
    const data = await CashFlowSvc.getForecast(
      companyId,
      q.horizon ?? 30,
      q.currency ?? "TRY"
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function historical(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await CashFlowSvc.getHistoricalContext(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
