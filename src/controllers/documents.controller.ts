// ============================================================================
// DOCUMENTS CONTROLLER (P9)
// ============================================================================

import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import * as DocSvc from "../services/documents.service";
import { recordAudit, extractRequestMeta } from "../utils/audit";

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

const linkSchema = z.object({
  entityType: z.enum(["customer", "deal", "quote", "contract"]),
  entityId: z.string().min(1),
  googleDocId: z.string().min(5),
});

export async function link(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const dto = linkSchema.parse(req.body) as any;
    const row = await DocSvc.linkDocument(companyId, userId, dto);
    await recordAudit({
      userId,
      companyId,
      action: "document.linked",
      entityType: dto.entityType,
      entityId: dto.entityId,
      metadata: { googleDocId: row.googleDocId, title: row.title },
      ...extractRequestMeta(req),
    });
    res.status(201).json({ success: true, data: row });
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
    const data = await DocSvc.listDocuments(companyId, {
      entityType:
        typeof req.query.entityType === "string"
          ? req.query.entityType
          : undefined,
      entityId:
        typeof req.query.entityId === "string"
          ? req.query.entityId
          : undefined,
    });
    res.status(200).json({ success: true, data });
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
    const data = await DocSvc.unlinkDocument(companyId, id);
    await recordAudit({
      userId,
      companyId,
      action: "document.unlinked",
      entityType: "document_link",
      entityId: id,
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
