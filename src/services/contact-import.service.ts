// ============================================================================
// CONTACT IMPORT SERVICE — Sprint 5 (Phase D)
// ----------------------------------------------------------------------------
// Shared parse → preview → commit pipeline for importing contacts (customers)
// from an uploaded .xlsx/.csv file OR a Google Sheet. Header auto-mapping
// understands English, Arabic, and Turkish column names. Commit upserts by
// phone-or-email so re-imports update instead of duplicating.
//
// Preview rows are held in a short-lived in-memory store keyed by an opaque
// uploadToken; commit replays them with the user-confirmed mapping. (Single
// instance on Railway — acceptable for an interactive import; tokens expire.)
// ============================================================================

import { randomUUID } from "crypto";
import { prisma } from "../config/database";

// CRM fields a column can map to. fullName is required for a row to import.
export const CONTACT_FIELDS = [
  "fullName",
  "email",
  "phone",
  "whatsappPhone",
  "companyName",
  "position",
  "country",
  "city",
  "address",
  "status",
  "notes",
  "source",
] as const;
export type ContactField = (typeof CONTACT_FIELDS)[number];

// Header alias → CRM field (lowercased, trimmed keys). EN + AR + TR.
const HEADER_ALIASES: Record<string, ContactField> = {
  fullname: "fullName", "full name": "fullName", name: "fullName",
  "الاسم": "fullName", "الاسم الكامل": "fullName", ad: "fullName", "ad soyad": "fullName", isim: "fullName",
  email: "email", mail: "email", "e-mail": "email", "البريد": "email", "البريد الإلكتروني": "email", eposta: "email", "e-posta": "email",
  phone: "phone", mobile: "phone", tel: "phone", telephone: "phone", "الهاتف": "phone", "الجوال": "phone", telefon: "phone",
  whatsapp: "whatsappPhone", "whatsapp phone": "whatsappPhone", wa: "whatsappPhone", "واتساب": "whatsappPhone",
  company: "companyName", "company name": "companyName", organization: "companyName", "الشركة": "companyName", sirket: "companyName", "şirket": "companyName", firma: "companyName",
  position: "position", title: "position", "job title": "position", "المنصب": "position", pozisyon: "position", unvan: "position",
  country: "country", "الدولة": "country", ulke: "country", "ülke": "country",
  city: "city", "المدينة": "city", sehir: "city", "şehir": "city",
  address: "address", "العنوان": "address", adres: "address",
  status: "status", "الحالة": "status", durum: "status",
  notes: "notes", note: "notes", comments: "notes", "ملاحظات": "notes", notlar: "notes", not: "notes",
  source: "source", origin: "source", "المصدر": "source", kaynak: "source",
};

export interface ParsedSheet {
  headers: string[];
  rows: string[][]; // data rows (header excluded), each aligned to headers
}

export interface ImportPreview {
  uploadToken: string;
  headers: string[];
  sampleRows: string[][]; // first 10 data rows
  suggestedMapping: Record<string, ContactField | null>; // header → field
  totalRows: number;
}

export interface ImportCommitResult {
  created: number;
  updated: number;
  skipped: number;
  errors: { row: number; message: string }[];
}

export const MAX_IMPORT_ROWS = 5000;

// ── In-memory preview store (opaque token → parsed rows) ───────────────────
interface StoredPreview {
  companyId: string;
  headers: string[];
  rows: string[][];
  expiresAt: number;
}
const previewStore = new Map<string, StoredPreview>();
const PREVIEW_TTL_MS = 30 * 60 * 1000;

function prunePreviews() {
  const now = Date.now();
  for (const [k, v] of previewStore) if (v.expiresAt <= now) previewStore.delete(k);
}

// ── CSV parsing (quote-aware) ──────────────────────────────────────────────
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === "," && !inQ) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

function parseCsv(text: string): ParsedSheet {
  // Strip a UTF-8 BOM if present so the first header isn't polluted.
  const clean = text.replace(/^﻿/, "");
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0]);
  const rows: string[][] = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCsvLine(lines[i]);
    rows.push(headers.map((_, idx) => vals[idx] ?? ""));
  }
  return { headers, rows };
}

async function parseXlsx(buffer: Buffer): Promise<ParsedSheet> {
  const ExcelJS = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return { headers: [], rows: [] };

  const matrix: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values as unknown[]; // 1-indexed; [0] is empty
    const cells: string[] = [];
    for (let i = 1; i < values.length; i++) {
      cells.push(cellToString(values[i]));
    }
    matrix.push(cells);
  });
  if (matrix.length === 0) return { headers: [], rows: [] };

  const headers = matrix[0].map((h) => h.trim());
  const rows = matrix.slice(1).map((r) => headers.map((_, idx) => (r[idx] ?? "").toString()));
  return { headers, rows };
}

function cellToString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    const o = v as { text?: string; result?: unknown; hyperlink?: string };
    if (typeof o.text === "string") return o.text;
    if (o.result !== undefined) return String(o.result);
    if (o.hyperlink) return o.hyperlink;
    if (v instanceof Date) return v.toISOString();
  }
  return String(v);
}

/** Parse an uploaded file by extension/content into a ParsedSheet. */
export async function parseUpload(filename: string, buffer: Buffer): Promise<ParsedSheet> {
  const lower = (filename || "").toLowerCase();
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    return parseXlsx(buffer);
  }
  return parseCsv(buffer.toString("utf8"));
}

// ── Preview ────────────────────────────────────────────────────────────────
export function suggestMapping(headers: string[]): Record<string, ContactField | null> {
  const out: Record<string, ContactField | null> = {};
  for (const h of headers) {
    const key = h.toLowerCase().trim();
    out[h] = HEADER_ALIASES[key] ?? null;
  }
  return out;
}

/** Store parsed rows + return a preview payload (token + sample + suggestion). */
export function buildPreview(companyId: string, parsed: ParsedSheet): ImportPreview {
  prunePreviews();
  const uploadToken = randomUUID();
  previewStore.set(uploadToken, {
    companyId,
    headers: parsed.headers,
    rows: parsed.rows.slice(0, MAX_IMPORT_ROWS),
    expiresAt: Date.now() + PREVIEW_TTL_MS,
  });
  return {
    uploadToken,
    headers: parsed.headers,
    sampleRows: parsed.rows.slice(0, 10),
    suggestedMapping: suggestMapping(parsed.headers),
    totalRows: Math.min(parsed.rows.length, MAX_IMPORT_ROWS),
  };
}

// ── Commit ───────────────────────────────────────────────────────────────
const VALID_STATUSES = new Set(["new", "active", "inactive", "lead", "vip", "churned"]);

function normPhone(p: string | null | undefined): string {
  return (p ?? "").replace(/[^0-9+]/g, "");
}

/**
 * Commit a previously-previewed upload using a header→field mapping. Upserts by
 * email or phone (per company). Returns created/updated/skipped + row errors.
 */
export async function commitImport(params: {
  companyId: string;
  uploadToken: string;
  mapping: Record<string, ContactField | null>;
  ownerId?: string | null;
}): Promise<ImportCommitResult> {
  const { companyId, uploadToken, mapping, ownerId } = params;
  prunePreviews();
  const stored = previewStore.get(uploadToken);
  if (!stored || stored.companyId !== companyId) {
    throw new Error("Upload session expired or not found — please re-upload the file");
  }

  const { headers, rows } = stored;
  // header index → field
  const colField: (ContactField | null)[] = headers.map((h) => mapping[h] ?? null);
  if (!colField.includes("fullName")) {
    throw new Error("Mapping must include a column mapped to Full Name");
  }

  const result: ImportCommitResult = { created: 0, updated: 0, skipped: 0, errors: [] };

  // Preload existing customers for in-memory dedup/upsert keying.
  const existing = await prisma.customer.findMany({
    where: { companyId },
    select: { id: true, email: true, phone: true, whatsappPhone: true },
  });
  const byEmail = new Map<string, string>();
  const byPhone = new Map<string, string>();
  for (const c of existing) {
    if (c.email) byEmail.set(c.email.toLowerCase(), c.id);
    if (c.phone) byPhone.set(normPhone(c.phone), c.id);
    if (c.whatsappPhone) byPhone.set(normPhone(c.whatsappPhone), c.id);
  }

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2; // header is row 1
    const raw = rows[i];
    const rec: Partial<Record<ContactField, string>> = {};
    for (let c = 0; c < colField.length; c++) {
      const field = colField[c];
      if (!field) continue;
      const val = (raw[c] ?? "").toString().trim();
      if (val) rec[field] = val;
    }

    const fullName = rec.fullName?.trim();
    if (!fullName) {
      result.skipped++;
      result.errors.push({ row: rowNum, message: "Missing Full Name" });
      continue;
    }

    const email = rec.email ? rec.email.toLowerCase() : null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      result.skipped++;
      result.errors.push({ row: rowNum, message: `Invalid email: ${email}` });
      continue;
    }
    const phone = rec.phone ?? null;
    const status = rec.status && VALID_STATUSES.has(rec.status.toLowerCase())
      ? rec.status.toLowerCase()
      : undefined;

    const data = {
      fullName,
      email,
      phone,
      whatsappPhone: rec.whatsappPhone ?? null,
      companyName: rec.companyName ?? null,
      position: rec.position ?? null,
      country: rec.country ?? null,
      city: rec.city ?? null,
      address: rec.address ?? null,
      notes: rec.notes ?? null,
      source: rec.source ?? "import",
      ...(status ? { status } : {}),
    };

    const existingId =
      (email && byEmail.get(email)) || (phone && byPhone.get(normPhone(phone))) || null;

    try {
      if (existingId) {
        await prisma.customer.update({ where: { id: existingId }, data });
        result.updated++;
      } else {
        const created = await prisma.customer.create({
          data: { companyId, ownerId: ownerId ?? null, status: "new", ...data },
          select: { id: true },
        });
        result.created++;
        // Track new keys so later rows in the same file dedup against them.
        if (email) byEmail.set(email, created.id);
        if (phone) byPhone.set(normPhone(phone), created.id);
      }
    } catch (e) {
      result.skipped++;
      result.errors.push({ row: rowNum, message: (e as Error).message.slice(0, 160) });
    }
  }

  previewStore.delete(uploadToken);
  return result;
}
