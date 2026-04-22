import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../config/database";
import * as activityService from "../services/activity.service";
import type { AuthenticatedRequest } from "../types";
import { badRequest } from "../middleware/errorHandler";
import { recordAudit, extractRequestMeta, diffObjects } from "../utils/audit";

const createSchema = z.object({
  type: z.enum(["note", "call", "email", "meeting", "task", "whatsapp"]),
  title: z.string().min(1).max(200),
  content: z.string().max(5000).optional(),
  customerId: z.string().uuid().optional(),
  dealId: z.string().uuid().optional(),
  dueDate: z.string().datetime().optional(),
  metadata: z.record(z.unknown()).optional(),
  brandId: z.string().uuid().nullable().optional(),
});

const listSchema = z.object({
  customerId: z.string().uuid().optional(),
  dealId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  type: z.string().optional(),
  brandId: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
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
    const activity = await activityService.createActivity(
      authReq.user.companyId,
      authReq.user.userId,
      dto
    );
    recordAudit({
      userId: authReq.user.userId,
      companyId: authReq.user.companyId,
      action: "activity.create",
      entityType: "activity",
      entityId: activity.id,
      after: activity,
      ...extractRequestMeta(req),
    }).catch(() => {});
    res.status(201).json({
      success: true,
      data: activity,
      message: "Activity logged",
    });
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
    const filters = listSchema.parse(req.query);
    const result = await activityService.listActivities(
      authReq.user.companyId,
      filters
    );
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}

export async function complete(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const id = getParamId(req);
    const before = await prisma.activity.findFirst({
      where: { id, companyId: authReq.user.companyId },
    });
    const activity = await activityService.completeActivity(
      authReq.user.companyId,
      id
    );
    recordAudit({
      userId: authReq.user.userId,
      companyId: authReq.user.companyId,
      action: "activity.complete",
      entityType: "activity",
      entityId: id,
      before,
      after: activity,
      changes: before
        ? diffObjects(
            before as unknown as Record<string, unknown>,
            activity as unknown as Record<string, unknown>
          )
        : null,
      ...extractRequestMeta(req),
    }).catch(() => {});
    res.json({
      success: true,
      data: activity,
      message: "Activity marked as complete",
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
    const before = await prisma.activity
      .findFirst({ where: { id, companyId: authReq.user.companyId } })
      .catch(() => null);
    const result = await activityService.deleteActivity(
      authReq.user.companyId,
      id
    );
    recordAudit({
      userId: authReq.user.userId,
      companyId: authReq.user.companyId,
      action: "activity.delete",
      entityType: "activity",
      entityId: id,
      before,
      ...extractRequestMeta(req),
    }).catch(() => {});
    res.json({ success: true, data: result, message: "Activity deleted" });
  } catch (error) {
    next(error);
  }
}