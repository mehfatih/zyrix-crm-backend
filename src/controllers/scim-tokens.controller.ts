// ============================================================================
// SCIM TOKEN MANAGEMENT (P7) — mounted under /api/scim-tokens
// ----------------------------------------------------------------------------
// Merchant-facing management surface for SCIM tokens. Uses the regular JWT
// auth flow (settings:integrations permission) because these tokens are
// issued from the dashboard.
// ============================================================================

import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import * as ScimSvc from "../services/scim.service";
import { recordAudit, extractRequestMeta } from "../utils/audit";

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

const issueSchema = z.object({ label: z.string().min(1).max(120) });

export async function issue(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const dto = issueSchema.parse(req.body) as any;
    const token = await ScimSvc.issueScimToken(companyId, userId, dto.label);
    await recordAudit({
      userId,
      companyId,
      action: "scim.token_issued",
      entityType: "scim_token",
      entityId: token.id,
      metadata: { label: token.label, prefix: token.prefix },
      ...extractRequestMeta(req),
    });
    res.status(201).json({ success: true, data: token });
  } catch (err) {
    next(err);
  }
}

export async function list(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await ScimSvc.listScimTokens(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function revoke(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const id = req.params.id as string;
    const data = await ScimSvc.revokeScimToken(companyId, id);
    await recordAudit({
      userId,
      companyId,
      action: "scim.token_revoked",
      entityType: "scim_token",
      entityId: id,
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
