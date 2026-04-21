import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as ContractSvc from "../services/contract.service";
import type { AuthenticatedRequest } from "../types";

const createSchema = z.object({
  customerId: z.string().min(1),
  dealId: z.string().optional().nullable(),
  title: z.string().min(1).max(500),
  description: z.string().max(10000).optional(),
  status: z
    .enum([
      "draft",
      "pending_signature",
      "signed",
      "active",
      "expired",
      "terminated",
    ])
    .optional(),
  startDate: z.coerce.date().optional().nullable(),
  endDate: z.coerce.date().optional().nullable(),
  renewalDate: z.coerce.date().optional().nullable(),
  signedAt: z.coerce.date().optional().nullable(),
  value: z.coerce.number().min(0).optional(),
  currency: z.string().min(2).max(8).optional(),
  fileUrl: z.string().url().optional(),
  fileName: z.string().max(500).optional(),
  notes: z.string().max(10000).optional(),
  terms: z.string().max(20000).optional(),
});

const updateSchema = createSchema.partial();

const listSchema = z.object({
  status: z
    .enum([
      "draft",
      "pending_signature",
      "signed",
      "active",
      "expired",
      "terminated",
    ])
    .optional(),
  customerId: z.string().optional(),
  expiringWithinDays: z.coerce.number().int().optional(),
  search: z.string().optional(),
  page: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
});

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const q = listSchema.parse(req.query);
    const data = await ContractSvc.listContracts(companyId, q);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function getOne(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await ContractSvc.getContract(
      companyId,
      req.params.id as string
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const dto = createSchema.parse(req.body);
    const data = await ContractSvc.createContract(
      companyId,
      userId,
      dto as ContractSvc.CreateContractDto
    );
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = updateSchema.parse(req.body);
    const data = await ContractSvc.updateContract(
      companyId,
      req.params.id as string,
      dto as ContractSvc.UpdateContractDto
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await ContractSvc.deleteContract(
      companyId,
      req.params.id as string
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function createReminder(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId, userId } = auth(req);
    const data = await ContractSvc.createReminderTask(
      companyId,
      userId,
      req.params.id as string
    );
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function stats(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await ContractSvc.getStats(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
