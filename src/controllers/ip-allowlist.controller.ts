// ============================================================================
// IP ALLOWLIST CONTROLLER (P4)
// ============================================================================

import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import * as IpSvc from "../services/ip-allowlist.service";
import { recordAudit, extractRequestMeta } from "../utils/audit";

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

export async function list(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const entries = await IpSvc.listAllowlist(companyId);
    res.status(200).json({
      success: true,
      data: {
        entries,
        currentIp: req.ip || null,
      },
    });
  } catch (err) {
    next(err);
  }
}

const createSchema = z.object({
  cidr: z.string().min(1).max(60),
  label: z.string().min(1).max(120),
});

export async function create(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const dto = createSchema.parse(req.body) as any;
    const entry = await IpSvc.addAllowlistEntry(companyId, userId, dto);
    await recordAudit({
      userId,
      companyId,
      action: "ip_allowlist.added",
      entityType: "ip_allowlist",
      entityId: entry.id,
      after: entry,
      ...extractRequestMeta(req),
    });
    res.status(201).json({ success: true, data: entry });
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
    const { userId, companyId } = auth(req);
    const id = req.params.id as string;
    const result = await IpSvc.deleteAllowlistEntry(companyId, id);
    if (result.deleted) {
      await recordAudit({
        userId,
        companyId,
        action: "ip_allowlist.removed",
        entityType: "ip_allowlist",
        entityId: id,
        ...extractRequestMeta(req),
      });
    }
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
