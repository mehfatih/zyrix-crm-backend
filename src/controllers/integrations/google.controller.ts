import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../../types";
import {
  createState,
  consumeState,
} from "../../services/oauth-state.service";
import { isGoogleConfigured, getWebAppUrl } from "../../services/google/config";
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  fetchProfileEmail,
} from "../../services/google/oauth";
import {
  getConnection,
  upsertConnection,
  getGoogleClient,
  setDriveFolderId,
  disconnectConnection,
} from "../../services/google/connections.service";
import { ensureZyrixFolder, driveFolderUrl, uploadFileToFolder } from "../../services/google/drive";
import { createSheetExport, readSheetValues } from "../../services/google/sheets";
import { buildEntityRows } from "../../services/export.service";
import { buildPreview, MAX_IMPORT_ROWS } from "../../services/contact-import.service";
import {
  generateQuotePdf,
  generateContractPdf,
} from "../../services/quote-contract-pdf.service";
import { integrationError } from "../../lib/errors/integrationErrors";
import { badRequest } from "../../middleware/errorHandler";
import { recordIntegrationEvent } from "../../services/integration-events.service";
import { recordAudit, extractRequestMeta } from "../../utils/audit";

// ============================================================================
// GOOGLE WORKSPACE INTEGRATION CONTROLLER (/api/integrations/google) — Sprint 5
// ----------------------------------------------------------------------------
// OAuth 2.0 authorization-code grant, offline access, drive.file scope only,
// tokens encrypted at rest. The callback is the only public route; it
// identifies the company via the one-shot oauth_states nonce.
// ============================================================================

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

const SUPPORTED_LOCALES = new Set(["en", "ar", "tr"]);
function safeLocale(input: unknown): string {
  return typeof input === "string" && SUPPORTED_LOCALES.has(input) ? input : "en";
}

// ──────────────────────────────────────────────────────────────────────
// GET /status — { connected, available, googleEmail?, driveFolderUrl? }
// available:false → web hides all Google UI (graceful degradation).
// ──────────────────────────────────────────────────────────────────────
export async function status(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const available = isGoogleConfigured();
    const conn = await getConnection(companyId);
    const connected = Boolean(conn && conn.status === "active");

    res.status(200).json({
      success: true,
      data: {
        available,
        connected,
        googleEmail: connected ? conn!.googleEmail : undefined,
        driveFolderUrl:
          connected && conn!.driveFolderId
            ? driveFolderUrl(conn!.driveFolderId)
            : undefined,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// POST /connect — body { locale? }. Returns { authorizeUrl } to navigate to.
// ──────────────────────────────────────────────────────────────────────
export async function connect(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, companyId } = auth(req);
    if (!isGoogleConfigured()) {
      throw integrationError(
        "GOOGLE_NOT_CONFIGURED",
        "Google integration is not configured on this deployment",
        { companyId, platform: "google" }
      );
    }

    const locale = safeLocale(req.body?.locale ?? req.query.locale);
    const state = await createState({
      provider: "google",
      companyId,
      userId,
      returnUrl: `/${locale}/settings/integrations`,
      metadata: { locale },
    });

    await recordIntegrationEvent({
      companyId,
      platform: "google",
      eventType: "oauth_start",
      requestContext: { userId, locale, route: req.originalUrl },
    });

    const authorizeUrl = buildAuthorizeUrl(state);
    res.status(200).json({ success: true, data: { authorizeUrl } });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// GET /callback — PUBLIC. Google redirects the merchant's browser here.
// All outcomes redirect back to the web integrations page with a status flag.
// ──────────────────────────────────────────────────────────────────────
function returnUrl(locale: string, params: string): string {
  const base = getWebAppUrl();
  return `${base}/${locale}/settings/integrations?${params}`;
}

export async function callback(req: Request, res: Response) {
  let locale = "en";
  let companyIdForLog: string | null = null;

  const fail = async (code: string, message: string) => {
    await recordIntegrationEvent({
      companyId: companyIdForLog,
      platform: "google",
      eventType: "oauth_failure",
      errorCode: code,
      errorMessage: message,
      requestContext: { route: req.originalUrl, requestId: (req as { id?: string }).id },
    });
    return res.redirect(returnUrl(locale, `google=error&code=${encodeURIComponent(code)}`));
  };

  try {
    const q = req.query as Record<string, unknown>;
    if (q.error) {
      return fail("GOOGLE_AUTH_FAILED", `Consent denied or Google error: ${String(q.error)}`);
    }

    const code = typeof q.code === "string" ? q.code : "";
    const state = typeof q.state === "string" ? q.state : "";
    if (!code || !state) {
      return fail("GOOGLE_AUTH_FAILED", "Missing code/state in callback");
    }

    // One-shot state nonce → identifies the company + locale.
    const consumed = await consumeState(state);
    if (!consumed || consumed.provider !== "google") {
      return fail("INVALID_STATE", "OAuth state expired, reused, or unknown");
    }
    companyIdForLog = consumed.companyId;
    locale = safeLocale((consumed.metadata as { locale?: string }).locale);

    // Exchange code → tokens, then fetch identity email.
    const tokens = await exchangeCodeForTokens(code);
    const googleEmail = await fetchProfileEmail(tokens.accessToken);

    await upsertConnection({ companyId: consumed.companyId, googleEmail, tokens });

    // Create the "Zyrix CRM" Drive folder (best-effort: a folder failure must
    // not block the connection — exports/imports can create it lazily later).
    try {
      const client = await getGoogleClient(consumed.companyId);
      const folderId = await ensureZyrixFolder(client);
      await setDriveFolderId(consumed.companyId, folderId);
    } catch (folderErr) {
      console.warn(
        "[google] Zyrix CRM folder creation deferred (non-fatal):",
        (folderErr as Error).message
      );
    }

    await recordIntegrationEvent({
      companyId: consumed.companyId,
      platform: "google",
      eventType: "oauth_success",
      requestContext: { googleEmail, locale },
    });
    await recordAudit({
      userId: consumed.userId,
      companyId: consumed.companyId,
      action: "integration.google.connected",
      entityType: "google_connection",
      entityId: consumed.companyId,
      metadata: { googleEmail },
      ...extractRequestMeta(req),
    });

    return res.redirect(returnUrl(locale, "google=connected"));
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return fail(e.code ?? "INTERNAL_ERROR", e.message ?? "Unexpected callback error");
  }
}

// ──────────────────────────────────────────────────────────────────────
// Resolve the company's Zyrix CRM folder id, creating it lazily if the
// connect-time creation was deferred. Returns { client, folderId }.
// ──────────────────────────────────────────────────────────────────────
async function resolveClientAndFolder(companyId: string) {
  const client = await getGoogleClient(companyId); // throws GOOGLE_NOT_CONNECTED
  const conn = await getConnection(companyId);
  let folderId = conn?.driveFolderId ?? null;
  if (!folderId) {
    folderId = await ensureZyrixFolder(client);
    await setDriveFolderId(companyId, folderId);
  }
  return { client, folderId };
}

function exportTimestamp(): string {
  // "YYYY-MM-DD HH:mm" in UTC — stable, locale-independent file label.
  const iso = new Date().toISOString(); // 2026-06-04T21:30:12.000Z
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

// ──────────────────────────────────────────────────────────────────────
// POST /export/sheets — body { entity: "contacts" | "deals", filters? }
// Creates a formatted spreadsheet in the Zyrix CRM folder. Returns { url, rowCount }.
// ──────────────────────────────────────────────────────────────────────
const ENTITY_LABELS: Record<"contacts" | "deals", { entityType: "customers" | "deals"; label: string }> = {
  contacts: { entityType: "customers", label: "Zyrix Contacts" },
  deals: { entityType: "deals", label: "Zyrix Deals" },
};

export async function exportSheets(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, companyId } = auth(req);
    const entity = req.body?.entity;
    if (entity !== "contacts" && entity !== "deals") {
      throw badRequest("entity must be 'contacts' or 'deals'");
    }
    const filters =
      req.body?.filters && typeof req.body.filters === "object" ? req.body.filters : {};

    const { entityType, label } = ENTITY_LABELS[entity as "contacts" | "deals"];
    const { client, folderId } = await resolveClientAndFolder(companyId);

    const { headers, rows } = await buildEntityRows(companyId, entityType, filters);
    const title = `${label} — ${exportTimestamp()}`;

    const result = await createSheetExport({ client, folderId, title, headers, rows });

    await recordIntegrationEvent({
      companyId,
      platform: "google",
      eventType: "google_export",
      requestContext: { userId, entity, rowCount: result.rowCount },
    });

    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// POST /import/sheet — body { fileId } (from Google Picker). Reads the sheet
// and returns the SAME preview shape as a file upload; commit then runs
// through the generic /api/import/contacts/commit with the uploadToken.
// ──────────────────────────────────────────────────────────────────────
export async function importSheet(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, companyId } = auth(req);
    const fileId = typeof req.body?.fileId === "string" ? req.body.fileId : "";
    if (!fileId) throw badRequest("fileId is required");

    const client = await getGoogleClient(companyId); // throws GOOGLE_NOT_CONNECTED
    const { headers, rows } = await readSheetValues(client, fileId);
    if (headers.length === 0) throw badRequest("The selected sheet has no readable header row");
    if (rows.length > MAX_IMPORT_ROWS) {
      throw badRequest(`Too many rows — the maximum is ${MAX_IMPORT_ROWS}`);
    }

    const preview = buildPreview(companyId, { headers, rows });

    await recordIntegrationEvent({
      companyId,
      platform: "google",
      eventType: "google_import",
      requestContext: { userId, fileId, totalRows: preview.totalRows },
    });

    res.status(200).json({ success: true, data: preview });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// POST /save-to-drive — body { type: "quote" | "contract", id }
// Generates the record's PDF and uploads it into the Zyrix CRM folder.
// Returns { url }.
// ──────────────────────────────────────────────────────────────────────
export async function saveToDrive(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, companyId } = auth(req);
    const type = req.body?.type;
    const id = typeof req.body?.id === "string" ? req.body.id : "";
    if (type !== "quote" && type !== "contract") {
      throw badRequest("type must be 'quote' or 'contract'");
    }
    if (!id) throw badRequest("id is required");

    const { buffer, filename } =
      type === "quote"
        ? await generateQuotePdf(companyId, id)
        : await generateContractPdf(companyId, id);

    const { client, folderId } = await resolveClientAndFolder(companyId);
    const uploaded = await uploadFileToFolder({
      client,
      folderId,
      filename,
      mimeType: "application/pdf",
      buffer,
    });

    await recordIntegrationEvent({
      companyId,
      platform: "google",
      eventType: "google_save_to_drive",
      requestContext: { userId, type, id, fileId: uploaded.id },
    });

    res.status(200).json({ success: true, data: { url: uploaded.webViewLink } });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// POST /disconnect — best-effort remote revoke, delete local row, audit.
// ──────────────────────────────────────────────────────────────────────
export async function disconnect(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, companyId } = auth(req);
    const existed = await disconnectConnection(companyId);

    if (existed) {
      await recordIntegrationEvent({
        companyId,
        platform: "google",
        eventType: "disconnect",
        requestContext: { userId },
      });
      await recordAudit({
        userId,
        companyId,
        action: "integration.google.disconnected",
        entityType: "google_connection",
        entityId: companyId,
        ...extractRequestMeta(req),
      });
    }

    res.status(200).json({ success: true, data: { disconnected: true } });
  } catch (err) {
    next(err);
  }
}
