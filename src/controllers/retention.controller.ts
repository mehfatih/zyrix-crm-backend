// ============================================================================
// DATA RETENTION CONTROLLER (P5)
// ============================================================================

import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import * as RetentionSvc from "../services/retention.service";
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
    const policies = await RetentionSvc.listPolicies(companyId);
    res.status(200).json({
      success: true,
      data: {
        policies,
        supportedEntities: RetentionSvc.SUPPORTED_ENTITIES,
      },
    });
  } catch (err) {
    next(err);
  }
}

const upsertSchema = z.object({
  entityType: z.string().min(1).max(50),
  retentionDays: z.coerce.number().int().min(0).max(2555),
  legalHold: z.boolean().optional(),
  legalHoldReason: z.string().max(500).nullable().optional(),
});

export async function upsert(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const dto = upsertSchema.parse(req.body) as any;
    const before = await RetentionSvc.listPolicies(companyId).then((arr) =>
      arr.find((p) => p.entityType === dto.entityType) ?? null
    );
    const policy = await RetentionSvc.upsertPolicy(companyId, dto);
    await recordAudit({
      userId,
      companyId,
      action: "retention.upserted",
      entityType: "retention_policy",
      entityId: policy.id,
      before,
      after: policy,
      metadata: { entityType: policy.entityType },
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data: policy });
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
    const entityType = req.params.entityType as string;
    const result = await RetentionSvc.deletePolicy(companyId, entityType);
    await recordAudit({
      userId,
      companyId,
      action: "retention.removed",
      entityType: "retention_policy",
      metadata: { entityType },
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
