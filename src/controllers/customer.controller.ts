import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as customerService from "../services/customer.service";
import type { AuthenticatedRequest } from "../types";
import { badRequest } from "../middleware/errorHandler";
import {
  recordAudit,
  extractRequestMeta,
  diffObjects,
} from "../utils/audit";

const createSchema = z.object({
  fullName: z.string().min(2).max(100),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  whatsappPhone: z.string().optional(),
  companyName: z.string().max(100).optional(),
  position: z.string().max(100).optional(),
  country: z.string().max(100).optional(),
  city: z.string().max(100).optional(),
  address: z.string().max(500).optional(),
  source: z.string().max(50).optional(),
  status: z.enum(["new", "qualified", "customer", "lost"]).optional(),
  notes: z.string().max(2000).optional(),
  brandId: z.string().uuid().nullable().optional(),
});

const updateSchema = createSchema.partial().extend({
  ownerId: z.string().uuid().nullable().optional(),
  lifetimeValue: z.number().nonnegative().optional(),
});

const listSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  search: z.string().optional(),
  status: z.string().optional(),
  ownerId: z.string().uuid().optional(),
  brandId: z.string().optional(), // uuid OR 'unbranded' sentinel
  sortBy: z.enum(["createdAt", "fullName", "lifetimeValue"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

// ─────────────────────────────────────────────────────────────────────────
// Helper: extract single string from req.params (handles string | string[])
// ─────────────────────────────────────────────────────────────────────────
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
    const customer = await customerService.createCustomer(
      authReq.user.companyId,
      authReq.user.userId,
      dto
    );
    recordAudit({
      userId: authReq.user.userId,
      companyId: authReq.user.companyId,
      action: "customer.create",
      entityType: "customer",
      entityId: customer.id,
      after: customer,
      ...extractRequestMeta(req),
    }).catch(() => {});
    res.status(201).json({
      success: true,
      data: customer,
      message: "Customer created",
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
    const query = listSchema.parse(req.query);
    const result = await customerService.listCustomers(
      authReq.user.companyId,
      query
    );
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
    const customer = await customerService.getCustomerById(
      authReq.user.companyId,
      id
    );
    res.json({ success: true, data: customer });
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
    const before = await customerService.getCustomerById(
      authReq.user.companyId,
      id
    );
    const customer = await customerService.updateCustomer(
      authReq.user.companyId,
      id,
      dto
    );
    recordAudit({
      userId: authReq.user.userId,
      companyId: authReq.user.companyId,
      action: "customer.update",
      entityType: "customer",
      entityId: id,
      before,
      after: customer,
      changes: diffObjects(
        before as unknown as Record<string, unknown>,
        customer as unknown as Record<string, unknown>
      ),
      ...extractRequestMeta(req),
    }).catch(() => {});
    res.json({ success: true, data: customer, message: "Customer updated" });
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
    const before = await customerService
      .getCustomerById(authReq.user.companyId, id)
      .catch(() => null);
    const result = await customerService.deleteCustomer(
      authReq.user.companyId,
      id
    );
    recordAudit({
      userId: authReq.user.userId,
      companyId: authReq.user.companyId,
      action: "customer.delete",
      entityType: "customer",
      entityId: id,
      before,
      ...extractRequestMeta(req),
    }).catch(() => {});
    res.json({ success: true, data: result, message: "Customer deleted" });
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
    const data = await customerService.getCustomerStats(
      authReq.user.companyId
    );
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}