import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as LoyaltySvc from "../services/loyalty.service";
import type { AuthenticatedRequest } from "../types";

// ============================================================================
// LOYALTY CONTROLLER
// ============================================================================

const tierSchema = z.object({
  name: z.string().min(1).max(100),
  threshold: z.coerce.number().min(0),
  multiplier: z.coerce.number().min(0.1).max(10),
});

const upsertProgramSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  isActive: z.boolean().optional(),
  pointsPerUnit: z.coerce.number().min(0).optional(),
  currency: z.string().min(2).max(8).optional(),
  minRedeem: z.coerce.number().int().min(0).optional(),
  redeemValue: z.coerce.number().min(0).optional(),
  tiers: z.array(tierSchema).optional(),
  rules: z.record(z.string(), z.any()).optional(),
});

const createTxnSchema = z.object({
  customerId: z.string().min(1),
  points: z.coerce.number().int(),
  type: z.enum(["earn", "redeem", "adjust", "expire"]),
  reason: z.string().max(1000).optional(),
  referenceType: z.string().max(100).optional(),
  referenceId: z.string().max(100).optional(),
});

const listTxnsSchema = z.object({
  page: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
  customerId: z.string().optional(),
  type: z.enum(["earn", "redeem", "adjust", "expire"]).optional(),
});

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

// Program
export async function getProgram(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await LoyaltySvc.getProgram(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function upsertProgram(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const dto = upsertProgramSchema.parse(req.body);
    const data = await LoyaltySvc.upsertProgram(
      companyId,
      dto as LoyaltySvc.UpsertProgramDto
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// Transactions
export async function listTransactions(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const q = listTxnsSchema.parse(req.query);
    const data = await LoyaltySvc.listTransactions(companyId, q);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function createTransaction(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId, userId } = auth(req);
    const dto = createTxnSchema.parse(req.body);
    const data = await LoyaltySvc.createTransaction(
      companyId,
      userId,
      dto as LoyaltySvc.CreateTxnDto
    );
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function deleteTransaction(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await LoyaltySvc.deleteTransaction(
      companyId,
      req.params.id as string
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// Customer loyalty view
export async function getCustomerLoyalty(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await LoyaltySvc.getCustomerLoyalty(
      companyId,
      req.params.customerId as string
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// Stats
export async function stats(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await LoyaltySvc.getProgramStats(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// Top members
export async function topMembers(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const limit = Math.min(
      100,
      Math.max(1, Number(req.query.limit) || 20)
    );
    const data = await LoyaltySvc.getTopMembers(companyId, limit);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
