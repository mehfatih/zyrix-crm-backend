import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import * as Ad from "../services/ad-campaign.service";

// ============================================================================
// CAMPAIGN ECONOMICS CONTROLLER (/api/ad-campaigns, session auth) — Sprint 24
// Read = any authenticated user; build/mutate = owner/admin/manager (router).
// ============================================================================

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId, role: r.user.role };
}

function notFoundRes(res: Response, what = "Campaign") {
  return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: `${what} not found` } });
}

const campaignSchema = z.object({
  name: z.string().max(200).optional(),
  platform: z.enum(Ad.AD_PLATFORMS).optional(),
  externalId: z.string().max(128).nullable().optional(),
  accountCurrency: z.string().max(8).nullable().optional(),
  status: z.enum(Ad.CAMPAIGN_STATUSES).optional(),
  objective: z.string().max(200).nullable().optional(),
  targetRoas: z.number().nonnegative().max(99999999).nullable().optional(),
  targetCpa: z.number().nonnegative().max(999999999999).nullable().optional(),
  alertsEnabled: z.boolean().optional(),
});

const spendSchema = z.object({
  spendDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/, "spendDate must be YYYY-MM-DD"),
  amount: z.number().nonnegative().max(999999999999),
  currency: z.string().max(8).optional(),
  note: z.string().max(500).nullable().optional(),
});

// ── Campaigns ───────────────────────────────────────────────────────────────

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await Ad.listCampaigns(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

export async function getOne(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await Ad.getCampaign(companyId, String(req.params.id));
    if (!data) return notFoundRes(res);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const dto = campaignSchema.parse(req.body);
    const data = await Ad.createCampaign(companyId, userId, dto);
    res.status(201).json({ success: true, data });
  } catch (err) { next(err); }
}

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = campaignSchema.partial().parse(req.body);
    const data = await Ad.updateCampaign(companyId, String(req.params.id), dto);
    if (!data) return notFoundRes(res);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const ok = await Ad.deleteCampaign(companyId, String(req.params.id));
    if (!ok) return notFoundRes(res);
    res.status(200).json({ success: true });
  } catch (err) { next(err); }
}

// ── Spend ledger ──────────────────────────────────────────────────────────────

export async function listSpend(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const campaign = await Ad.getCampaign(companyId, String(req.params.id));
    if (!campaign) return notFoundRes(res);
    const data = await Ad.listSpend(companyId, String(req.params.id));
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

function handleSpendError(err: unknown, res: Response, next: NextFunction) {
  if (err instanceof Ad.SpendValidationError) {
    return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: err.message } });
  }
  next(err);
}

export async function addSpend(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const dto = spendSchema.parse(req.body);
    const data = await Ad.addSpend(companyId, String(req.params.id), userId, dto);
    if (!data) return notFoundRes(res);
    res.status(201).json({ success: true, data });
  } catch (err) { handleSpendError(err, res, next); }
}

export async function updateSpend(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = spendSchema.partial().parse(req.body);
    const data = await Ad.updateSpend(companyId, String(req.params.id), String(req.params.spendId), dto);
    if (!data) return notFoundRes(res, "Spend entry");
    res.status(200).json({ success: true, data });
  } catch (err) { handleSpendError(err, res, next); }
}

export async function deleteSpend(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const ok = await Ad.deleteSpend(companyId, String(req.params.id), String(req.params.spendId));
    if (!ok) return notFoundRes(res, "Spend entry");
    res.status(200).json({ success: true });
  } catch (err) { next(err); }
}
