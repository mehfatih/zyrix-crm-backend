import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import {
  getProfile,
  upsertProfile,
  deleteProfile,
  previewProfile,
} from "../services/company-ai-profile.service";

// ============================================================================
// AI STUDIO CONTROLLER — /api/ai-studio/* (Sprint 13)
// ============================================================================

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

const profileSchema = z.object({
  tone: z.enum(["formal", "friendly", "concise"]).nullable().optional(),
  businessContext: z.string().max(4000).nullable().optional(),
  preferredLanguage: z.string().max(40).nullable().optional(),
  customInstructions: z.string().max(2000).nullable().optional(),
});

export async function get(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    res.json({ success: true, data: await getProfile(companyId) });
  } catch (e) {
    next(e);
  }
}

export async function save(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = profileSchema.parse(req.body);
    res.json({ success: true, data: await upsertProfile(companyId, dto) });
  } catch (e) {
    next(e);
  }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    await deleteProfile(companyId);
    res.json({ success: true, data: { deleted: true } });
  } catch (e) {
    next(e);
  }
}

const previewSchema = z.object({ question: z.string().min(1).max(1000) });

export async function preview(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const { question } = previewSchema.parse(req.body);
    res.json({ success: true, data: await previewProfile(companyId, question) });
  } catch (e) {
    next(e);
  }
}
