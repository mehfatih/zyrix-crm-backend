import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import {
  getProfile,
  upsertProfile,
  deleteProfile,
  previewProfile,
} from "../services/company-ai-profile.service";
import {
  listReports,
  getReport,
  createReport,
  updateReport,
  deleteReport,
  runReport,
  type ReportSchedule,
} from "../services/saved-ai-reports.service";

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

// ── Saved AI reports ──────────────────────────────────────────────────────
const reportSchema = z.object({
  name: z.string().min(1).max(160),
  prompt: z.string().min(1).max(4000),
  schedule: z.enum(["daily", "weekly", "manual"]).optional(),
  recipients: z.array(z.string().email()).max(20).optional(),
});
const reportUpdateSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  prompt: z.string().min(1).max(4000).optional(),
  schedule: z.enum(["daily", "weekly", "manual"]).optional(),
  recipients: z.array(z.string().email()).max(20).optional(),
  status: z.enum(["active", "paused"]).optional(),
});

export async function listReportsH(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    res.json({ success: true, data: await listReports(companyId) });
  } catch (e) { next(e); }
}

export async function createReportH(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const dto = reportSchema.parse(req.body);
    const r = await createReport(companyId, userId, {
      name: dto.name,
      prompt: dto.prompt,
      schedule: dto.schedule as ReportSchedule | undefined,
      recipients: dto.recipients,
    });
    res.status(201).json({ success: true, data: r });
  } catch (e) { next(e); }
}

export async function updateReportH(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = reportUpdateSchema.parse(req.body);
    res.json({ success: true, data: await updateReport(companyId, String(req.params.id), dto as any) });
  } catch (e) { next(e); }
}

export async function deleteReportH(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    await deleteReport(companyId, String(req.params.id));
    res.json({ success: true, data: { deleted: true } });
  } catch (e) { next(e); }
}

export async function runReportH(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const id = String(req.params.id);
    const found = await getReport(companyId, id);
    if (!found) return res.status(404).json({ success: false, error: { message: "Report not found" } });
    const text = await runReport(companyId, id);
    res.json({ success: true, data: { result: text } });
  } catch (e) { next(e); }
}
