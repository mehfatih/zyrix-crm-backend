import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "../services/api-keys.service";
import { recordAudit, extractRequestMeta } from "../utils/audit";

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return {
    userId: r.user.userId,
    companyId: r.user.companyId,
    role: r.user.role,
  };
}

const createSchema = z.object({
  name: z.string().min(1).max(120),
  scope: z.enum(["read", "write"]).optional(),
});

export async function create(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId, role } = auth(req);
    // API keys give full company access. Owner/admin only.
    if (role !== "owner" && role !== "admin") {
      return res.status(403).json({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: "Only owners and admins can create API keys.",
        },
      });
    }
    const dto = createSchema.parse(req.body) as any;
    const result = await createApiKey(companyId, userId, dto);
    await recordAudit({
      userId,
      companyId,
      action: "api_key.created",
      entityType: "api_key",
      entityId: result.id,
      metadata: { name: result.name, scope: result.scope, prefix: result.keyPrefix },
      ...extractRequestMeta(req),
    });
    // plaintextKey is included ONLY in this creation response, never
    // again. Front-end must prompt the user to copy it now.
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, role } = auth(req);
    if (role !== "owner" && role !== "admin") {
      return res.status(403).json({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: "Only owners and admins can view API keys.",
        },
      });
    }
    const includeRevoked = req.query.includeRevoked === "true";
    const data = await listApiKeys(companyId, { includeRevoked });
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
    const { userId, companyId, role } = auth(req);
    if (role !== "owner" && role !== "admin") {
      return res.status(403).json({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: "Only owners and admins can revoke API keys.",
        },
      });
    }
    const id = req.params.id as string;
    const result = await revokeApiKey(companyId, id);
    await recordAudit({
      userId,
      companyId,
      action: "api_key.revoked",
      entityType: "api_key",
      entityId: id,
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
