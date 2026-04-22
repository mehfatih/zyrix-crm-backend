import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as dealService from "../services/deal.service";
import type { AuthenticatedRequest } from "../types";
import { badRequest } from "../middleware/errorHandler";
import {
  recordAudit,
  extractRequestMeta,
  diffObjects,
} from "../utils/audit";

const createSchema = z.object({
  customerId: z.string().uuid(),
  title: z.string().min(2).max(200),
  value: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  stage: z
    .enum(["lead", "qualified", "proposal", "negotiation", "won", "lost"])
    .optional(),
  probability: z.number().int().min(0).max(100).optional(),
  expectedCloseDate: z.string().datetime().optional(),
  description: z.string().max(2000).optional(),
  brandId: z.string().uuid().nullable().optional(),
});

const updateSchema = z.object({
  title: z.string().min(2).max(200).optional(),
  value: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  stage: z
    .enum(["lead", "qualified", "proposal", "negotiation", "won", "lost"])
    .optional(),
  probability: z.number().int().min(0).max(100).optional(),
  expectedCloseDate: z.string().datetime().nullable().optional(),
  actualCloseDate: z.string().datetime().nullable().optional(),
  description: z.string().max(2000).optional(),
  lostReason: z.string().max(500).optional(),
  ownerId: z.string().uuid().nullable().optional(),
  brandId: z.string().uuid().nullable().optional(),
});

const listSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  stage: z.string().optional(),
  customerId: z.string().uuid().optional(),
  ownerId: z.string().uuid().optional(),
  brandId: z.string().optional(),
  sortBy: z.enum(["createdAt", "value", "expectedCloseDate"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

function getParamId(req: Request, key: string = "id"): string {
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
    const deal = await dealService.createDeal(
      authReq.user.companyId,
      authReq.user.userId,
      dto
    );
    recordAudit({
      userId: authReq.user.userId,
      companyId: authReq.user.companyId,
      action: "deal.create",
      entityType: "deal",
      entityId: deal.id,
      after: deal,
      ...extractRequestMeta(req),
    }).catch(() => {});
    res.status(201).json({ success: true, data: deal, message: "Deal created" });
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
    const result = await dealService.listDeals(authReq.user.companyId, query);
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
    const deal = await dealService.getDealById(authReq.user.companyId, id);
    res.json({ success: true, data: deal });
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
    const before = await dealService
      .getDealById(authReq.user.companyId, id)
      .catch(() => null);
    const deal = await dealService.updateDeal(
      authReq.user.companyId,
      id,
      dto
    );
    const stageChanged =
      before &&
      typeof (before as any).stage === "string" &&
      (before as any).stage !== (deal as any).stage;
    recordAudit({
      userId: authReq.user.userId,
      companyId: authReq.user.companyId,
      action: stageChanged ? "deal.stage_changed" : "deal.update",
      entityType: "deal",
      entityId: id,
      before,
      after: deal,
      changes: before
        ? diffObjects(
            before as unknown as Record<string, unknown>,
            deal as unknown as Record<string, unknown>
          )
        : undefined,
      ...extractRequestMeta(req),
    }).catch(() => {});
    res.json({ success: true, data: deal, message: "Deal updated" });
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
    const before = await dealService
      .getDealById(authReq.user.companyId, id)
      .catch(() => null);
    const result = await dealService.deleteDeal(authReq.user.companyId, id);
    recordAudit({
      userId: authReq.user.userId,
      companyId: authReq.user.companyId,
      action: "deal.delete",
      entityType: "deal",
      entityId: id,
      before,
      ...extractRequestMeta(req),
    }).catch(() => {});
    res.json({ success: true, data: result, message: "Deal deleted" });
  } catch (error) {
    next(error);
  }
}

export async function pipeline(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const data = await dealService.getPipeline(authReq.user.companyId);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

export async function stats(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const data = await dealService.getDealStats(authReq.user.companyId);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}