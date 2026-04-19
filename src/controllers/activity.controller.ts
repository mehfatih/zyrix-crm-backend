import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as activityService from "../services/activity.service";
import type { AuthenticatedRequest } from "../types";

const createSchema = z.object({
  type: z.enum(["note", "call", "email", "meeting", "task", "whatsapp"]),
  title: z.string().min(1).max(200),
  content: z.string().max(5000).optional(),
  customerId: z.string().uuid().optional(),
  dealId: z.string().uuid().optional(),
  dueDate: z.string().datetime().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const listSchema = z.object({
  customerId: z.string().uuid().optional(),
  dealId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  type: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export async function create(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const dto = createSchema.parse(req.body);
    const activity = await activityService.createActivity(
      authReq.user.companyId,
      authReq.user.userId,
      dto
    );
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
    const { id } = req.params;
    const activity = await activityService.completeActivity(
      authReq.user.companyId,
      id
    );
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
    const { id } = req.params;
    const result = await activityService.deleteActivity(
      authReq.user.companyId,
      id
    );
    res.json({ success: true, data: result, message: "Activity deleted" });
  } catch (error) {
    next(error);
  }
}