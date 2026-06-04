import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types";
import { getRevenueBrain, type Locale } from "../services/revenue-brain.service";

export async function revenueBrain(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const r = req as AuthenticatedRequest;
    const localeRaw = String(req.query.locale ?? "en");
    const locale: Locale =
      localeRaw === "ar" || localeRaw === "tr" ? localeRaw : "en";
    const data = await getRevenueBrain(r.user.companyId, locale);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
