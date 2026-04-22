// ============================================================================
// AUDIT LOGS (P2)
// ----------------------------------------------------------------------------
// Primary merchant-facing audit endpoints. `/api/security/audit` is kept
// as-is for the existing frontend; this module adds:
//   GET /api/audit-logs           — list with pagination + filters
//   GET /api/audit-logs/actions   — distinct actions (filter dropdown)
//   GET /api/audit-logs/export.json
//   GET /api/audit-logs/export.csv
// All routes are gated behind requirePermission('admin:audit').
// ============================================================================

import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import * as AuditSvc from "../services/audit.service";

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId, role: r.user.role };
}

const querySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  page: z.coerce.number().int().positive().optional(),
  action: z.string().optional(),
  actionPrefix: z.string().optional(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  userId: z.string().optional(),
  // Accept either ISO or yyyy-MM-dd. Also accept the handoff-named
  // `from`/`to` aliases in addition to since/until for flexibility.
  since: z.coerce.date().optional(),
  from: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

function normalize(raw: z.infer<typeof querySchema>) {
  const limit = raw.limit ?? 50;
  const offset =
    raw.offset ??
    (raw.page && raw.page > 1 ? (raw.page - 1) * limit : 0);
  const since = raw.since ?? raw.from;
  const until = raw.until ?? raw.to;
  return {
    limit,
    offset,
    action: raw.action,
    actionPrefix: raw.actionPrefix,
    entityType: raw.entityType,
    entityId: raw.entityId,
    userId: raw.userId,
    since,
    until,
  };
}

export async function list(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const q = normalize(querySchema.parse(req.query) as any);
    const data = await AuditSvc.listCompanyAuditLogs(companyId, q);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function actions(
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

// ──────────────────────────────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────────────────────────────
// Capped at 10,000 rows to keep response size predictable. Frontend
// surfaces a banner when the export is truncated.
// ──────────────────────────────────────────────────────────────────────

const EXPORT_CAP = 10000;

async function loadForExport(
  companyId: string,
  raw: z.infer<typeof querySchema>
) {
  const q = normalize(raw);
  return AuditSvc.listCompanyAuditLogs(companyId, {
    ...q,
    limit: EXPORT_CAP,
    offset: 0,
  });
}

export async function exportJson(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const q = querySchema.parse(req.query) as any;
    const { items, pagination } = await loadForExport(companyId, q);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="audit-logs-${new Date()
        .toISOString()
        .slice(0, 10)}.json"`
    );
    res.status(200).send(
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          total: pagination.total,
          cap: EXPORT_CAP,
          truncated: pagination.total > items.length,
          items,
        },
        null,
        2
      )
    );
  } catch (err) {
    next(err);
  }
}

export async function exportCsv(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const q = querySchema.parse(req.query) as any;
    const { items } = await loadForExport(companyId, q);

    const header = [
      "id",
      "createdAt",
      "userId",
      "userFullName",
      "userEmail",
      "action",
      "entityType",
      "entityId",
      "ipAddress",
      "userAgent",
      "sessionId",
      "metadata",
      "changes",
      "before",
      "after",
    ];

    const rows: string[] = [header.join(",")];
    for (const e of items as any[]) {
      rows.push(
        [
          e.id,
          e.createdAt instanceof Date ? e.createdAt.toISOString() : e.createdAt,
          e.userId ?? "",
          e.user?.fullName ?? "",
          e.user?.email ?? "",
          e.action,
          e.entityType ?? "",
          e.entityId ?? "",
          e.ipAddress ?? "",
          e.userAgent ?? "",
          e.sessionId ?? "",
          jsonCell(e.metadata),
          jsonCell(e.changes),
          jsonCell(e.before),
          jsonCell(e.after),
        ]
          .map(csvEscape)
          .join(",")
      );
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="audit-logs-${new Date()
        .toISOString()
        .slice(0, 10)}.csv"`
    );
    // Excel-friendly BOM so Arabic/Turkish strings render correctly on Windows.
    res.status(200).send("﻿" + rows.join("\r\n"));
  } catch (err) {
    next(err);
  }
}

function jsonCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  // Quote whenever the cell contains a comma, quote, CR, or LF, and
  // double any embedded quotes per RFC 4180.
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
