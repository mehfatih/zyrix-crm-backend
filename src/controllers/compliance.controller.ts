// ============================================================================
// COMPLIANCE CONTROLLER (P6)
// ============================================================================

import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import * as ComplianceSvc from "../services/compliance.service";
import { recordAudit, extractRequestMeta } from "../utils/audit";

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

// ──────────────────────────────────────────────────────────────────────
// Tokens
// ──────────────────────────────────────────────────────────────────────

const issueSchema = z.object({ label: z.string().min(1).max(120) });

export async function issueToken(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const dto = issueSchema.parse(req.body) as any;
    const token = await ComplianceSvc.issueComplianceToken(
      companyId,
      userId,
      dto.label
    );
    await recordAudit({
      userId,
      companyId,
      action: "compliance.token_issued",
      entityType: "compliance_token",
      entityId: token.id,
      metadata: { label: token.label, prefix: token.prefix },
      ...extractRequestMeta(req),
    });
    res.status(201).json({ success: true, data: token });
  } catch (err) {
    next(err);
  }
}

export async function listTokens(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await ComplianceSvc.listComplianceTokens(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function revokeToken(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const id = req.params.id as string;
    const data = await ComplianceSvc.revokeComplianceToken(companyId, id);
    await recordAudit({
      userId,
      companyId,
      action: "compliance.token_revoked",
      entityType: "compliance_token",
      entityId: id,
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Per-user data export
// ──────────────────────────────────────────────────────────────────────

export async function exportUser(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId: actorId, companyId } = auth(req);
    const targetUserId = req.params.userId as string;
    const data = await ComplianceSvc.exportUserData(companyId, targetUserId);
    await recordAudit({
      userId: actorId,
      companyId,
      action: "compliance.user_exported",
      entityType: "user",
      entityId: targetUserId,
      metadata: { via: actorId.startsWith("compliance:") ? "token" : "jwt" },
      ...extractRequestMeta(req),
    });
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="user-${targetUserId}-export-${new Date()
        .toISOString()
        .slice(0, 10)}.json"`
    );
    res.status(200).send(JSON.stringify(data, null, 2));
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Per-user data deletion
// ──────────────────────────────────────────────────────────────────────

export async function deleteUser(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId: actorId, companyId } = auth(req);
    const targetUserId = req.params.userId as string;
    const data = await ComplianceSvc.deleteUserData(companyId, targetUserId);
    await recordAudit({
      userId: actorId,
      companyId,
      action: "compliance.user_deleted",
      entityType: "user",
      entityId: targetUserId,
      metadata: { via: actorId.startsWith("compliance:") ? "token" : "jwt" },
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Audit report
// ──────────────────────────────────────────────────────────────────────

const reportSchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
});

export async function report(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const q = reportSchema.parse(req.query) as any;
    const data = await ComplianceSvc.auditReport(companyId, q.from, q.to);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
