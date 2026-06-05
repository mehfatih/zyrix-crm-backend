import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import {
  scanDuplicates,
  aiVerdict,
  mergeContacts,
  undoMerge,
  listMergeLogs,
  cleanupPreviewSvc,
  cleanupApplySvc,
  cleanupUndoSvc,
  type CleanupRule,
} from "../services/data-tools.service";

// ============================================================================
// DATA TOOLS CONTROLLER — /api/data-tools/* (Sprint 13)
// ============================================================================

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

const scanSchema = z.object({ page: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(50).optional() });
const verdictSchema = z.object({ idA: z.string().min(1), idB: z.string().min(1) });
const mergeSchema = z.object({
  keepId: z.string().min(1),
  mergeId: z.string().min(1),
  fieldChoices: z.record(z.enum(["keep", "merge"])).optional(),
});

export async function dedupeScan(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = scanSchema.parse(req.body ?? {});
    res.json({ success: true, data: await scanDuplicates(companyId, dto) });
  } catch (e) { next(e); }
}

export async function dedupeVerdict(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const { idA, idB } = verdictSchema.parse(req.body);
    res.json({ success: true, data: await aiVerdict(companyId, idA, idB) });
  } catch (e) { next(e); }
}

export async function merge(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const dto = mergeSchema.parse(req.body) as {
      keepId: string;
      mergeId: string;
      fieldChoices?: Record<string, "keep" | "merge">;
    };
    res.json({ success: true, data: await mergeContacts(companyId, userId, dto) });
  } catch (e) { next(e); }
}

export async function undo(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    res.json({ success: true, data: await undoMerge(companyId, String(req.params.logId)) });
  } catch (e) { next(e); }
}

export async function mergeLogs(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    res.json({ success: true, data: await listMergeLogs(companyId) });
  } catch (e) { next(e); }
}

const cleanupSchema = z.object({
  rules: z.array(z.enum(["phone_e164", "trim_whitespace", "name_case", "email_lowercase"])).min(1),
});

export async function cleanupPreview(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const { rules } = cleanupSchema.parse(req.body);
    res.json({ success: true, data: await cleanupPreviewSvc(companyId, rules as CleanupRule[]) });
  } catch (e) { next(e); }
}

export async function cleanupApply(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const { rules } = cleanupSchema.parse(req.body);
    res.json({ success: true, data: await cleanupApplySvc(companyId, userId, rules as CleanupRule[]) });
  } catch (e) { next(e); }
}

export async function cleanupUndo(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    res.json({ success: true, data: await cleanupUndoSvc(companyId, String(req.params.logId)) });
  } catch (e) { next(e); }
}
