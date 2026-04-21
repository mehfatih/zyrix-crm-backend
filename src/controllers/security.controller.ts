import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import bcrypt from "bcrypt";
import type { AuthenticatedRequest } from "../types";
import { prisma } from "../config/database";
import { AppError, unauthorized } from "../middleware/errorHandler";
import * as TwoFactorSvc from "../services/twofactor.service";
import * as AuditSvc from "../services/audit.service";
import { recordAudit, extractRequestMeta } from "../utils/audit";

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

// ============================================================================
// 2FA
// ============================================================================

export async function twoFactorStatus(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId } = auth(req);
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        twoFactorEnabled: true,
        twoFactorBackupCodes: true,
      },
    });
    res.status(200).json({
      success: true,
      data: {
        enabled: u?.twoFactorEnabled ?? false,
        backupCodesRemaining: u?.twoFactorBackupCodes?.length ?? 0,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function beginEnroll(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const data = await TwoFactorSvc.beginEnroll(userId);
    await recordAudit({
      userId,
      companyId,
      action: "2fa.begin_enroll",
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

const confirmSchema = z.object({ code: z.string().min(6).max(10) });

export async function confirmEnroll(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const { code } = confirmSchema.parse(req.body ?? {});
    const data = await TwoFactorSvc.confirmEnroll(userId, code);
    await recordAudit({
      userId,
      companyId,
      action: "2fa.enabled",
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// Disabling 2FA is a destructive security change — re-verify the user's
// password before we turn the protection off. This matches how every
// major SaaS handles it.
const disableSchema = z.object({ password: z.string().min(1) });

export async function disable2FA(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const { password } = disableSchema.parse(req.body ?? {});

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });
    if (!user?.passwordHash) {
      throw unauthorized("Password verification required");
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      throw new AppError("Incorrect password", 400, "INVALID_PASSWORD");
    }

    const data = await TwoFactorSvc.disable(userId);
    await recordAudit({
      userId,
      companyId,
      action: "2fa.disabled",
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function regenerateBackupCodes(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const data = await TwoFactorSvc.regenerateBackupCodes(userId);
    await recordAudit({
      userId,
      companyId,
      action: "2fa.backup_codes_regenerated",
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ============================================================================
// AUDIT LOG
// ============================================================================

const auditQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  action: z.string().optional(),
  actionPrefix: z.string().optional(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  userId: z.string().optional(),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
});

export async function listAudit(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const q = auditQuerySchema.parse(req.query);
    const data = await AuditSvc.listCompanyAuditLogs(companyId, q);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function listAuditActions(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await AuditSvc.listDistinctActions(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
