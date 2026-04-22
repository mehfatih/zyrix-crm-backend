// ============================================================================
// NETWORK RULES CONTROLLER (P8) — super-admin only
// ============================================================================

import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import * as NetSvc from "../services/network-rules.service";

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId };
}

export async function list(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const data = await NetSvc.listRules();
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

const createSchema = z.object({
  type: z.enum(["geo_block", "rate_limit", "ddos_heuristic"]),
  label: z.string().min(1).max(200),
  config: z.record(z.string(), z.any()),
  active: z.boolean().optional(),
});

export async function create(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId } = auth(req);
    const dto = createSchema.parse(req.body) as any;
    const rule = await NetSvc.createRule(userId, dto);
    res.status(201).json({ success: true, data: rule });
  } catch (err) {
    next(err);
  }
}

const updateSchema = z.object({
  label: z.string().min(1).max(200).optional(),
  config: z.record(z.string(), z.any()).optional(),
  active: z.boolean().optional(),
});

export async function update(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = req.params.id as string;
    const dto = updateSchema.parse(req.body) as any;
    const rule = await NetSvc.updateRule(id, dto);
    res.status(200).json({ success: true, data: rule });
  } catch (err) {
    next(err);
  }
}

export async function remove(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = req.params.id as string;
    const data = await NetSvc.deleteRule(id);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
