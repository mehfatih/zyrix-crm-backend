import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as AICFOSvc from "../services/ai-cfo.service";
import type { AuthenticatedRequest } from "../types";

const askSchema = z.object({
  question: z.string().min(3).max(2000),
  locale: z.enum(["en", "ar", "tr"]).optional(),
});

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

export async function snapshot(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await AICFOSvc.buildSnapshot(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function ask(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = askSchema.parse(req.body);
    const data = await AICFOSvc.askAICFO(
      companyId,
      dto.question,
      dto.locale ?? "en"
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function templates(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const locale = (req.query.locale as string) || "en";
    const t =
      (AICFOSvc.PROMPT_TEMPLATES as any)[locale] ??
      AICFOSvc.PROMPT_TEMPLATES.en;
    res.status(200).json({ success: true, data: t });
  } catch (err) {
    next(err);
  }
}
