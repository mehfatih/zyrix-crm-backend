import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as productService from "../services/product.service";
import * as stockService from "../services/stock.service";
import type { AuthenticatedRequest } from "../types";
import { badRequest } from "../middleware/errorHandler";
import { recordAudit, extractRequestMeta, diffObjects } from "../utils/audit";

const createSchema = z.object({
  name: z.string().min(1).max(300),
  sku: z.string().max(120).nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
  price: z.number().nonnegative().optional(),
  cost: z.number().nonnegative().nullable().optional(),
  currency: z.string().length(3).optional(),
  taxRate: z.number().min(0).max(100).nullable().optional(),
  unit: z.string().max(40).nullable().optional(),
  imageUrl: z.string().url().max(2000).nullable().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(300).optional(),
  sku: z.string().max(120).nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
  price: z.number().nonnegative().optional(),
  cost: z.number().nonnegative().nullable().optional(),
  currency: z.string().length(3).optional(),
  taxRate: z.number().min(0).max(100).nullable().optional(),
  unit: z.string().max(40).nullable().optional(),
  imageUrl: z.string().url().max(2000).nullable().optional(),
  status: z.enum(["active", "archived"]).optional(),
});

const listSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(500).default(20),
  search: z.string().max(200).optional(),
  source: z.string().max(40).optional(),
  status: z.enum(["active", "archived"]).optional(),
  lowStock: z.coerce.boolean().optional(),
});

const statusSchema = z.object({ status: z.enum(["active", "archived"]) });

const movementSchema = z.object({
  type: z.enum(["in", "out", "adjust"]),
  qty: z.number().refine((n) => n !== 0, "qty must be non-zero"),
  location: z.string().max(80).optional(),
  reason: z.string().max(200).nullable().optional(),
  refType: z.string().max(40).nullable().optional(),
  refId: z.string().max(80).nullable().optional(),
  override: z.boolean().optional(),
});

const thresholdSchema = z.object({
  lowStockThreshold: z.number().min(0).nullable(),
  location: z.string().max(80).optional(),
});

const movementsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  location: z.string().max(80).optional(),
});

function getParamId(req: Request, key = "id"): string {
  const value = req.params[key];
  if (!value) throw badRequest(`Missing parameter: ${key}`);
  return Array.isArray(value) ? value[0] : value;
}

export async function create(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const dto = createSchema.parse(req.body) as any;
    const product = await productService.createProduct(
      authReq.user.companyId,
      dto
    );
    recordAudit({
      userId: authReq.user.userId,
      companyId: authReq.user.companyId,
      action: "product.create",
      entityType: "product",
      entityId: product.id,
      after: product,
      ...extractRequestMeta(req),
    }).catch(() => {});
    res
      .status(201)
      .json({ success: true, data: product, message: "Product created" });
  } catch (error) {
    next(error);
  }
}

export async function list(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const query = listSchema.parse(req.query);
    const result = await productService.listProducts(
      authReq.user.companyId,
      query
    );
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}

export async function getOne(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const id = getParamId(req);
    const product = await productService.getProductById(
      authReq.user.companyId,
      id
    );
    res.json({ success: true, data: product });
  } catch (error) {
    next(error);
  }
}

export async function update(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const id = getParamId(req);
    const dto = updateSchema.parse(req.body);
    const before = await productService
      .getProductById(authReq.user.companyId, id)
      .catch(() => null);
    const product = await productService.updateProduct(
      authReq.user.companyId,
      id,
      dto
    );
    recordAudit({
      userId: authReq.user.userId,
      companyId: authReq.user.companyId,
      action: "product.update",
      entityType: "product",
      entityId: id,
      before,
      after: product,
      changes: before
        ? diffObjects(
            before as unknown as Record<string, unknown>,
            product as unknown as Record<string, unknown>
          )
        : undefined,
      ...extractRequestMeta(req),
    }).catch(() => {});
    res.json({ success: true, data: product, message: "Product updated" });
  } catch (error) {
    next(error);
  }
}

export async function setStatus(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const id = getParamId(req);
    const { status } = statusSchema.parse(req.body);
    const product = await productService.setProductStatus(
      authReq.user.companyId,
      id,
      status
    );
    recordAudit({
      userId: authReq.user.userId,
      companyId: authReq.user.companyId,
      action: status === "archived" ? "product.archive" : "product.unarchive",
      entityType: "product",
      entityId: id,
      after: product,
      ...extractRequestMeta(req),
    }).catch(() => {});
    res.json({
      success: true,
      data: product,
      message: status === "archived" ? "Product archived" : "Product restored",
    });
  } catch (error) {
    next(error);
  }
}

export async function remove(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const id = getParamId(req);
    const before = await productService
      .getProductById(authReq.user.companyId, id)
      .catch(() => null);
    const result = await productService.deleteProduct(
      authReq.user.companyId,
      id
    );
    recordAudit({
      userId: authReq.user.userId,
      companyId: authReq.user.companyId,
      action: "product.delete",
      entityType: "product",
      entityId: id,
      before,
      ...extractRequestMeta(req),
    }).catch(() => {});
    res.json({ success: true, data: result, message: "Product deleted" });
  } catch (error) {
    next(error);
  }
}

// ── STOCK ──────────────────────────────────────────────────────────────────
export async function createMovement(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const id = getParamId(req);
    const dto = movementSchema.parse(req.body) as any;
    const result = await stockService.createMovement(
      authReq.user.companyId,
      id,
      authReq.user.userId,
      dto
    );
    recordAudit({
      userId: authReq.user.userId,
      companyId: authReq.user.companyId,
      action: "product.stock_movement",
      entityType: "product",
      entityId: id,
      after: result,
      ...extractRequestMeta(req),
    }).catch(() => {});
    res
      .status(201)
      .json({ success: true, data: result, message: "Movement recorded" });
  } catch (error) {
    next(error);
  }
}

export async function listMovements(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const id = getParamId(req);
    const query = movementsQuerySchema.parse(req.query);
    const movements = await stockService.listMovements(
      authReq.user.companyId,
      id,
      query
    );
    res.json({ success: true, data: { movements } });
  } catch (error) {
    next(error);
  }
}

export async function setThreshold(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const id = getParamId(req);
    const { lowStockThreshold, location } = thresholdSchema.parse(req.body);
    const level = await stockService.setThreshold(
      authReq.user.companyId,
      id,
      lowStockThreshold,
      location
    );
    res.json({ success: true, data: level, message: "Threshold updated" });
  } catch (error) {
    next(error);
  }
}
