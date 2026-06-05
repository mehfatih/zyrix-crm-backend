import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as dealItemsService from "../services/deal-items.service";
import type { AuthenticatedRequest } from "../types";
import { badRequest } from "../middleware/errorHandler";
import { recordAudit, extractRequestMeta } from "../utils/audit";

const createSchema = z.object({
  productId: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(300),
  qty: z.number().positive().optional(),
  unitPrice: z.number().nonnegative(),
  discountPct: z.number().min(0).max(100).optional(),
  taxRate: z.number().min(0).max(100).nullable().optional(),
  position: z.number().int().min(0).optional(),
});

const updateSchema = z.object({
  productId: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(300).optional(),
  qty: z.number().positive().optional(),
  unitPrice: z.number().nonnegative().optional(),
  discountPct: z.number().min(0).max(100).optional(),
  taxRate: z.number().min(0).max(100).nullable().optional(),
  position: z.number().int().min(0).optional(),
});

const deductSchema = z.object({ override: z.boolean().optional() });

function param(req: Request, key: string): string {
  const value = req.params[key];
  if (!value) throw badRequest(`Missing parameter: ${key}`);
  return Array.isArray(value) ? value[0] : value;
}

export async function list(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const data = await dealItemsService.listItems(
      authReq.user.companyId,
      param(req, "id")
    );
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

export async function create(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const dealId = param(req, "id");
    const dto = createSchema.parse(req.body) as any;
    const item = await dealItemsService.createItem(
      authReq.user.companyId,
      dealId,
      dto
    );
    recordAudit({
      userId: authReq.user.userId,
      companyId: authReq.user.companyId,
      action: "deal.item_added",
      entityType: "deal",
      entityId: dealId,
      after: item,
      ...extractRequestMeta(req),
    }).catch(() => {});
    res.status(201).json({ success: true, data: item, message: "Item added" });
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
    const dealId = param(req, "id");
    const itemId = param(req, "itemId");
    const dto = updateSchema.parse(req.body) as any;
    const item = await dealItemsService.updateItem(
      authReq.user.companyId,
      dealId,
      itemId,
      dto
    );
    res.json({ success: true, data: item, message: "Item updated" });
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
    const dealId = param(req, "id");
    const itemId = param(req, "itemId");
    const result = await dealItemsService.deleteItem(
      authReq.user.companyId,
      dealId,
      itemId
    );
    res.json({ success: true, data: result, message: "Item removed" });
  } catch (error) {
    next(error);
  }
}

export async function deductStock(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const dealId = param(req, "id");
    const { override } = deductSchema.parse(req.body);
    const result = await dealItemsService.deductStock(
      authReq.user.companyId,
      dealId,
      authReq.user.userId,
      override ?? false
    );
    recordAudit({
      userId: authReq.user.userId,
      companyId: authReq.user.companyId,
      action: "deal.stock_deducted",
      entityType: "deal",
      entityId: dealId,
      after: result,
      ...extractRequestMeta(req),
    }).catch(() => {});
    res.json({ success: true, data: result, message: "Stock deducted" });
  } catch (error) {
    next(error);
  }
}
