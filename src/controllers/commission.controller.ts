import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as CommissionSvc from "../services/commission.service";
import type { AuthenticatedRequest } from "../types";

const configSchema = z.object({
  rate: z.coerce.number().optional(),
  amount: z.coerce.number().optional(),
  tiers: z
    .array(
      z.object({
        from: z.coerce.number().min(0),
        to: z.coerce.number().optional(),
        rate: z.coerce.number().min(0).max(100),
      })
    )
    .optional(),
});

const createRuleSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  type: z.enum(["flat", "percent", "tiered"]),
  config: configSchema,
  appliesTo: z.enum(["all", "deal_stage", "min_value"]).optional(),
  appliesToValue: z.string().optional(),
  isActive: z.boolean().optional(),
  priority: z.coerce.number().int().optional(),
});

const updateRuleSchema = createRuleSchema.partial();

const listEntriesSchema = z.object({
  userId: z.string().optional(),
  status: z.enum(["pending", "approved", "paid", "cancelled"]).optional(),
  page: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
});

const updateStatusSchema = z.object({
  status: z.enum(["pending", "approved", "paid", "cancelled"]),
  notes: z.string().max(2000).optional(),
});

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

// Rules
export async function listRules(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await CommissionSvc.listRules(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function createRule(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const dto = createRuleSchema.parse(req.body);
    const data = await CommissionSvc.createRule(
      companyId,
      dto as CommissionSvc.CreateRuleDto
    );
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function updateRule(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const dto = updateRuleSchema.parse(req.body);
    const data = await CommissionSvc.updateRule(
      companyId,
      req.params.id as string,
      dto as CommissionSvc.UpdateRuleDto
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function deleteRule(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await CommissionSvc.deleteRule(
      companyId,
      req.params.id as string
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// Entries
export async function listEntries(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const q = listEntriesSchema.parse(req.query);
    const data = await CommissionSvc.listEntries(companyId, q);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function updateEntryStatus(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const dto = updateStatusSchema.parse(req.body);
    const data = await CommissionSvc.updateEntryStatus(
      companyId,
      req.params.id as string,
      dto.status,
      dto.notes
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function deleteEntry(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await CommissionSvc.deleteEntry(
      companyId,
      req.params.id as string
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function recompute(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await CommissionSvc.recomputeAll(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function stats(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await CommissionSvc.getStats(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
