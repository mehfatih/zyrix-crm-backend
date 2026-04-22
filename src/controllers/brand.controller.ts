import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import {
  getBrandSettings,
  updateBrandSettings,
  setCustomDomain,
  verifyCustomDomain,
  removeCustomDomain,
  resetBrandSettings,
  getPublicBrandByDomain,
} from "../services/brand.service";
import { recordAudit, extractRequestMeta } from "../utils/audit";

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return {
    userId: r.user.userId,
    companyId: r.user.companyId,
    role: r.user.role,
  };
}

// Authz enforced at the route level via requirePermission('settings:branding').

// ──────────────────────────────────────────────────────────────────────
// READ (authenticated) — /api/brand
// ──────────────────────────────────────────────────────────────────────

export async function get(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await getBrandSettings(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// UPDATE (authenticated, owner/admin)
// ──────────────────────────────────────────────────────────────────────

const updateSchema = z.object({
  displayName: z.string().max(100).nullable().optional(),
  logoUrl: z.string().url().nullable().optional(),
  faviconUrl: z.string().url().nullable().optional(),
  primaryColor: z.string().nullable().optional(),
  accentColor: z.string().nullable().optional(),
  emailFromName: z.string().max(100).nullable().optional(),
  emailFromAddress: z.string().email().nullable().optional(),
});

export async function update(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const dto = updateSchema.parse(req.body);
    const data = await updateBrandSettings(companyId, dto);
    await recordAudit({
      userId,
      companyId,
      action: "brand.updated",
      entityType: "brand_settings",
      entityId: data.id,
      metadata: { fields: Object.keys(dto) },
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// RESET — delete all brand overrides
// ──────────────────────────────────────────────────────────────────────

export async function reset(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const data = await resetBrandSettings(companyId);
    await recordAudit({
      userId,
      companyId,
      action: "brand.reset",
      entityType: "brand_settings",
      entityId: null,
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// CUSTOM DOMAIN (enterprise)
// ──────────────────────────────────────────────────────────────────────

const domainSchema = z.object({
  customDomain: z.string().min(3).max(253),
});

export async function setDomain(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const { customDomain } = domainSchema.parse(req.body);
    const data = await setCustomDomain(companyId, customDomain);
    await recordAudit({
      userId,
      companyId,
      action: "brand.custom_domain_set",
      entityType: "brand_settings",
      entityId: null,
      metadata: { customDomain: data.customDomain },
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function verifyDomain(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const data = await verifyCustomDomain(companyId);
    if (data.verified) {
      await recordAudit({
        userId,
        companyId,
        action: "brand.custom_domain_verified",
        entityType: "brand_settings",
        entityId: null,
        ...extractRequestMeta(req),
      });
    }
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function removeDomain(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const data = await removeCustomDomain(companyId);
    await recordAudit({
      userId,
      companyId,
      action: "brand.custom_domain_removed",
      entityType: "brand_settings",
      entityId: null,
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// PUBLIC — GET /api/brand/public?domain=<host>
// No auth. Returns the display name + logo + colors for a verified
// custom domain. Used by the frontend on the login page to render
// the customer's branding before the user is authenticated.
// ──────────────────────────────────────────────────────────────────────

export async function getPublic(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const domain =
      typeof req.query.domain === "string"
        ? req.query.domain
        : "";
    if (!domain) {
      return res
        .status(400)
        .json({ success: false, error: { code: "MISSING_DOMAIN", message: "?domain=" } });
    }
    const data = await getPublicBrandByDomain(domain);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
