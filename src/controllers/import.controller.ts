import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types";
import { badRequest } from "../middleware/errorHandler";
import { recordAudit, extractRequestMeta } from "../utils/audit";
import {
  parseUpload,
  buildPreview,
  commitImport,
  MAX_IMPORT_ROWS,
  type ContactField,
} from "../services/contact-import.service";

// ============================================================================
// CONTACT IMPORT CONTROLLER (/api/import) — Sprint 5 (Phase D)
// ----------------------------------------------------------------------------
// File-upload import path (.xlsx/.csv) — works with ZERO Google configuration.
// preview → returns headers + sample + suggested mapping + uploadToken;
// commit → upserts contacts using the user-confirmed mapping.
// ============================================================================

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

// POST /api/import/contacts/preview — multipart file field "file".
export async function previewContacts(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const file = (req as Request & { file?: { originalname: string; buffer: Buffer } }).file;
    if (!file || !file.buffer) {
      throw badRequest("No file uploaded (expected multipart field 'file')");
    }

    const parsed = await parseUpload(file.originalname, file.buffer);
    if (parsed.headers.length === 0) {
      throw badRequest("The file has no readable header row");
    }
    if (parsed.rows.length > MAX_IMPORT_ROWS) {
      throw badRequest(`Too many rows — the maximum is ${MAX_IMPORT_ROWS}`);
    }

    const preview = buildPreview(companyId, parsed);
    res.status(200).json({ success: true, data: preview });
  } catch (err) {
    next(err);
  }
}

// POST /api/import/contacts/commit — body { uploadToken, mapping }.
export async function commitContacts(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, companyId } = auth(req);
    const uploadToken = typeof req.body?.uploadToken === "string" ? req.body.uploadToken : "";
    const mapping = req.body?.mapping;
    if (!uploadToken) throw badRequest("uploadToken is required");
    if (!mapping || typeof mapping !== "object") throw badRequest("mapping is required");

    const result = await commitImport({
      companyId,
      uploadToken,
      mapping: mapping as Record<string, ContactField | null>,
      ownerId: userId,
    });

    await recordAudit({
      userId,
      companyId,
      action: "contacts.import",
      entityType: "customer",
      metadata: {
        created: result.created,
        updated: result.updated,
        skipped: result.skipped,
      },
      ...extractRequestMeta(req),
    });

    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
