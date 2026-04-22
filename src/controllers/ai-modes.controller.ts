// ============================================================================
// AI MODES CONTROLLER (P11)
// ============================================================================

import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import * as AiSvc from "../services/ai-modes.service";
import { recordAudit, extractRequestMeta } from "../utils/audit";

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

const architectSchema = z.object({
  businessDescription: z.string().min(5).max(2000),
  locale: z.enum(["en", "ar", "tr"]).optional(),
});

export async function architect(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const dto = architectSchema.parse(req.body) as any;
    const data = await AiSvc.architect(dto);
    await recordAudit({
      userId,
      companyId,
      action: "ai.architect",
      metadata: { length: dto.businessDescription.length },
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

const builderSchema = z.object({
  intent: z.string().min(3).max(1000),
  artifactType: z.enum(["workflow", "email", "landing"]),
});

export async function builder(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const dto = builderSchema.parse(req.body) as any;
    const data = await AiSvc.builder(dto);
    await recordAudit({
      userId,
      companyId,
      action: "ai.builder",
      metadata: { artifactType: dto.artifactType },
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

const reportSchema = z.object({
  question: z.string().min(3).max(500),
  locale: z.enum(["en", "ar", "tr"]).optional(),
});

export async function report(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const dto = reportSchema.parse(req.body) as any;
    const data = await AiSvc.report({ ...dto, companyId });
    await recordAudit({
      userId,
      companyId,
      action: "ai.report",
      metadata: { selectedQueryId: data.selectedQueryId },
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
