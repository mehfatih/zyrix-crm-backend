import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as FollowupSvc from "../services/followup.service";
import type { AuthenticatedRequest } from "../types";

const settingsSchema = z.object({
  isEnabled: z.boolean().optional(),
  warningDays: z.coerce.number().int().min(1).max(365).optional(),
  criticalDays: z.coerce.number().int().min(1).max(365).optional(),
  includeStatuses: z.array(z.string()).optional(),
  excludeInactive: z.boolean().optional(),
});

const bulkSchema = z.object({
  customerIds: z.array(z.string()).min(1).max(100),
});

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

export async function getSettings(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await FollowupSvc.getSettings(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function upsertSettings(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const dto = settingsSchema.parse(req.body);
    const data = await FollowupSvc.upsertSettings(
      companyId,
      dto as FollowupSvc.FollowupSettingsDto
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function stale(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await FollowupSvc.getStaleCustomers(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function createTask(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId, userId } = auth(req);
    const customerId = req.params.customerId as string;
    const data = await FollowupSvc.createFollowupTask(
      companyId,
      userId,
      customerId
    );
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function bulkCreateTasks(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId, userId } = auth(req);
    const dto = bulkSchema.parse(req.body);
    const data = await FollowupSvc.bulkCreateFollowupTasks(
      companyId,
      userId,
      dto.customerIds as string[]
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
