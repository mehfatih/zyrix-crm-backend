import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as TaskSvc from "../services/task.service";
import type { AuthenticatedRequest } from "../types";

// ============================================================================
// TASK CONTROLLER
// ============================================================================

const createTaskSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(10000).optional(),
  status: z.enum(["todo", "in_progress", "done", "cancelled"]).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  dueDate: z.coerce.date().optional().nullable(),
  assignedToId: z.string().optional().nullable(),
  customerId: z.string().optional().nullable(),
  dealId: z.string().optional().nullable(),
});

const updateTaskSchema = createTaskSchema.partial();

const listTasksSchema = z.object({
  page: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
  search: z.string().optional(),
  status: z.enum(["todo", "in_progress", "done", "cancelled"]).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  assignedToId: z.string().optional(),
  customerId: z.string().optional(),
  dealId: z.string().optional(),
  dueBefore: z.coerce.date().optional(),
  dueAfter: z.coerce.date().optional(),
  overdueOnly: z.coerce.boolean().optional(),
  sortBy: z.enum(["createdAt", "dueDate", "priority"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

export async function stats(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const data = await TaskSvc.getTaskStats(companyId, userId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const q = listTasksSchema.parse(req.query);
    const data = await TaskSvc.listTasks(companyId, userId, q);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const dto = createTaskSchema.parse(req.body);
    const data = await TaskSvc.createTask(
      companyId,
      userId,
      dto as TaskSvc.CreateTaskDto
    );
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function getOne(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await TaskSvc.getTask(companyId, req.params.id as string);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = updateTaskSchema.parse(req.body);
    const data = await TaskSvc.updateTask(
      companyId,
      req.params.id as string,
      dto as TaskSvc.UpdateTaskDto
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await TaskSvc.deleteTask(
      companyId,
      req.params.id as string
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
