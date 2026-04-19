import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as dealService from "../services/deal.service";
import type { AuthenticatedRequest } from "../types";

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
});

const listSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  stage: z.string().optional(),
  customerId: z.string().uuid().optional(),
  ownerId: z.string().uuid().optional(),
  sortBy: z.enum(["createdAt", "value", "expectedCloseDate"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

export async function create(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const dto = createSchema.parse(req.body);
    const deal = await dealService.createDeal(
      authReq.user.companyId,
      authReq.user.userId,
      dto
    );
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
    const { id } = req.params;
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
    const { id } = req.params;
    const dto = updateSchema.parse(req.body);
    const deal = await dealService.updateDeal(
      authReq.user.companyId,
      id,
      dto
    );
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
    const { id } = req.params;
    const result = await dealService.deleteDeal(authReq.user.companyId, id);
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