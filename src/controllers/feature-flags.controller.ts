import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import {
  FEATURE_CATALOG,
  getFullFeatureMap,
  setFeatureFlag,
  setBulkFeatures,
} from "../services/feature-flags.service";
import {
  getAdminMatrix,
  setOverride,
  resetAllOverrides,
  forceOnAll,
  listAudit,
  type OverrideMode,
} from "../services/entitlements.service";
import { recordAudit, extractRequestMeta } from "../utils/audit";

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId, role: r.user.role };
}

// ──────────────────────────────────────────────────────────────────────
// Public catalog — what features exist
// ──────────────────────────────────────────────────────────────────────

export function catalog(_req: Request, res: Response) {
  res.status(200).json({ success: true, data: FEATURE_CATALOG });
}

// ──────────────────────────────────────────────────────────────────────
// Current company's resolved flags (authenticated; any role)
// ──────────────────────────────────────────────────────────────────────

export async function currentCompanyFlags(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await getFullFeatureMap(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Admin — override flags for any company
// Routes mounted on /api/admin/companies/:id — caller is the platform
// owner, not the merchant. Access guarded by admin.middleware upstream.
// ──────────────────────────────────────────────────────────────────────

export async function adminGetCompanyFlags(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const data = await getFullFeatureMap(req.params.id as string);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

const singleSchema = z.object({
  key: z.string().min(1).max(100),
  enabled: z.boolean(),
});

export async function adminSetFlag(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId } = auth(req);
    const dto = singleSchema.parse(req.body) as any;
    const companyId = req.params.id as string;
    const data = await setFeatureFlag(companyId, dto.key, dto.enabled);
    await recordAudit({
      userId,
      companyId,
      action: "feature_flag.set",
      entityType: "company",
      entityId: companyId,
      metadata: { key: dto.key, enabled: dto.enabled },
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

const bulkSchema = z.object({
  flags: z.record(z.boolean()),
});

export async function adminSetBulk(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId } = auth(req);
    const dto = bulkSchema.parse(req.body) as any;
    const companyId = req.params.id as string;
    const data = await setBulkFeatures(companyId, dto.flags);
    await recordAudit({
      userId,
      companyId,
      action: "feature_flag.set_bulk",
      entityType: "company",
      entityId: companyId,
      metadata: { count: Object.keys(dto.flags).length },
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Sprint 16C — god-mode entitlement matrix (super-admin)
// Mounted on /api/admin/companies/:id/entitlements*
// ──────────────────────────────────────────────────────────────────────

export async function adminGetMatrix(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getAdminMatrix(req.params.id as string);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

const overrideSchema = z.object({
  mode: z.enum(["inherit", "force_on", "force_off"]),
  limitOverride: z.number().int().min(0).nullable().optional(),
});

export async function adminSetOverride(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId } = auth(req);
    const companyId = req.params.id as string;
    const key = req.params.key as string;
    const dto = overrideSchema.parse(req.body);
    const data = await setOverride(
      companyId,
      key,
      dto.mode as OverrideMode,
      dto.limitOverride ?? null,
      userId
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function adminResetEntitlements(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId } = auth(req);
    const data = await resetAllOverrides(req.params.id as string, userId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function adminForceOnAll(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId } = auth(req);
    const data = await forceOnAll(req.params.id as string, userId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function adminEntitlementAudit(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await listAudit(req.params.id as string, 50);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
