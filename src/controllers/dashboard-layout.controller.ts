import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import {
  getLayout,
  saveLayout,
  resetLayout,
} from "../services/dashboard-layout.service";

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

export async function get(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const data = await getLayout(companyId, userId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

const saveSchema = z.object({
  widgets: z.array(z.any()).max(24),
});

export async function save(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const { widgets } = saveSchema.parse(req.body);
    const data = await saveLayout(companyId, userId, widgets);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function reset(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const data = await resetLayout(companyId, userId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
