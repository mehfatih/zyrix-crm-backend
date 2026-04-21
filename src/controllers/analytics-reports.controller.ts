import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import {
  METRIC_CATALOG,
  runMetric,
  listScheduledReports,
  createScheduledReport,
  updateScheduledReport,
  deleteScheduledReport,
} from "../services/analytics-reports.service";

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

// ──────────────────────────────────────────────────────────────────────
// Catalog + runner
// ──────────────────────────────────────────────────────────────────────

export function catalog(_req: Request, res: Response) {
  res.status(200).json({ success: true, data: METRIC_CATALOG });
}

const runSchema = z.object({ metricKey: z.string().min(1) });

export async function run(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const { metricKey } = runSchema.parse(req.body);
    const data = await runMetric(companyId, metricKey);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Scheduled CRUD
// ──────────────────────────────────────────────────────────────────────

export async function listScheduled(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await listScheduledReports(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

const createSchema = z.object({
  name: z.string().min(1).max(120),
  cadence: z.enum(["daily", "weekly", "monthly"]),
  hour: z.number().int().min(0).max(23).optional(),
  dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
  dayOfMonth: z.number().int().min(1).max(28).nullable().optional(),
  metrics: z.array(z.string()).min(1),
  recipients: z.array(z.string().email()).min(1),
  isEnabled: z.boolean().optional(),
});

export async function createScheduled(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const dto = createSchema.parse(req.body) as any;
    const data = await createScheduledReport(companyId, userId, dto);
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

const updateSchema = createSchema.partial();

export async function updateScheduled(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const dto = updateSchema.parse(req.body) as any;
    const data = await updateScheduledReport(
      companyId,
      req.params.id as string,
      dto
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function deleteScheduled(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await deleteScheduledReport(
      companyId,
      req.params.id as string
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
