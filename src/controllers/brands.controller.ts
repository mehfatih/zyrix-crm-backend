import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import {
  listBrands,
  getBrand,
  createBrand,
  updateBrand,
  setDefaultBrand,
  deleteBrand,
  getBrandStats,
} from "../services/brands.service";
import { recordAudit, extractRequestMeta } from "../utils/audit";

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId, role: r.user.role };
}

function requireAdminOrOwner(req: Request, res: Response): boolean {
  const { role } = auth(req);
  if (role !== "owner" && role !== "admin") {
    res.status(403).json({
      success: false,
      error: { code: "FORBIDDEN", message: "Only owners and admins can manage brands." },
    });
    return false;
  }
  return true;
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const includeArchived = req.query.includeArchived === "true";
    const data = await listBrands(companyId, { includeArchived });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function detail(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await getBrand(companyId, req.params.id as string);
    if (!data) {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Brand not found" },
      });
    }
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

const createSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(3).max(62),
  logoUrl: z.string().url().nullable().optional(),
  primaryColor: z.string().nullable().optional(),
  description: z.string().max(500).nullable().optional(),
});

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    if (!requireAdminOrOwner(req, res)) return;
    const { userId, companyId } = auth(req);
    const dto = createSchema.parse(req.body) as any;
    const data = await createBrand(companyId, dto);
    await recordAudit({
      userId, companyId,
      action: "brand.created",
      entityType: "brand",
      entityId: data.id,
      metadata: { name: data.name, slug: data.slug },
      ...extractRequestMeta(req),
    });
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

const updateSchema = createSchema.partial().extend({
  isArchived: z.boolean().optional(),
});

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    if (!requireAdminOrOwner(req, res)) return;
    const { userId, companyId } = auth(req);
    const dto = updateSchema.parse(req.body) as any;
    const data = await updateBrand(companyId, req.params.id as string, dto);
    await recordAudit({
      userId, companyId,
      action: "brand.updated",
      entityType: "brand",
      entityId: data.id,
      metadata: { fields: Object.keys(dto) },
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function setDefault(req: Request, res: Response, next: NextFunction) {
  try {
    if (!requireAdminOrOwner(req, res)) return;
    const { userId, companyId } = auth(req);
    const data = await setDefaultBrand(companyId, req.params.id as string);
    await recordAudit({
      userId, companyId,
      action: "brand.set_default",
      entityType: "brand",
      entityId: data.id,
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    if (!requireAdminOrOwner(req, res)) return;
    const { userId, companyId } = auth(req);
    const data = await deleteBrand(companyId, req.params.id as string);
    await recordAudit({
      userId, companyId,
      action: data.archived ? "brand.archived" : "brand.deleted",
      entityType: "brand",
      entityId: req.params.id as string,
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function stats(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await getBrandStats(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
