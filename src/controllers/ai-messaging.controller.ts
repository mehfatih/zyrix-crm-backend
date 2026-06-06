import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import { isFeatureEnabled } from "../services/feature-flags.service";
import {
  generateDrafts, improveTone, translateMessage,
  type MessageTone, type MessageChannel, type MessageLanguage,
} from "../services/ai-messaging.service";

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}
async function ensureEnabled(companyId: string, res: Response): Promise<boolean> {
  if (await isFeatureEnabled(companyId, "ai_messaging")) return true;
  res.status(403).json({ success: false, error: { code: "NOT_ENABLED", message: "AI messaging not enabled" } });
  return false;
}

const TONES = ["professional", "friendly", "concise", "persuasive"] as const;
const draftSchema = z.object({
  contactId: z.string().optional(),
  channel: z.enum(["email", "whatsapp"]),
  tones: z.array(z.enum(TONES)).max(4).optional(),
  language: z.enum(["ar", "tr", "en"]).optional(),
  context: z.string().max(2000).optional(),
});
const improveSchema = z.object({
  content: z.string().min(1).max(4000),
  tone: z.enum(TONES),
  language: z.enum(["ar", "tr", "en"]),
});
const translateSchema = z.object({
  content: z.string().min(1).max(4000),
  to: z.enum(["ar", "tr", "en"]),
});

export async function draft(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    if (!(await ensureEnabled(companyId, res))) return;
    const dto = draftSchema.parse(req.body);
    const data = await generateDrafts(companyId, {
      contactId: dto.contactId,
      channel: dto.channel as MessageChannel,
      tones: dto.tones as MessageTone[] | undefined,
      language: dto.language as MessageLanguage | undefined,
      context: dto.context,
    });
    res.json({ success: true, data });
  } catch (e) { next(e); }
}

export async function improve(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    if (!(await ensureEnabled(companyId, res))) return;
    const dto = improveSchema.parse(req.body);
    const data = await improveTone(companyId, dto.content, dto.tone as MessageTone, dto.language as MessageLanguage);
    res.json({ success: true, data });
  } catch (e) { next(e); }
}

export async function translate(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    if (!(await ensureEnabled(companyId, res))) return;
    const dto = translateSchema.parse(req.body);
    const data = await translateMessage(companyId, dto.content, dto.to as MessageLanguage);
    res.json({ success: true, data });
  } catch (e) { next(e); }
}
