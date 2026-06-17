// ============================================================================
// PLANNED ACQUISITION SPEND (CAC Sprint 2, Phase 2) — scheduled future spend
// (raw SQL, tenant-scoped).
// ----------------------------------------------------------------------------
// Planned future ad spend + planned non-ad costs, keyed by month, so Sprint-3
// forecasting can project next month's CAC from scheduled spend × historical
// conversion. THIRD separate table by design:
//   ad_spend_entries (Sprint 24)  = ACTUAL ad spend       ← untouched
//   acquisition_costs (Phase 1)    = ACTUAL non-ad costs   ← untouched
//   planned_acquisition_spend      = PLANNED future spend  ← THIS
// computeMonthlyCac() reads ONLY the two ACTUAL tables and NEVER this one, so
// planned rows CANNOT affect actual CAC (zero regression — proven by verify).
// ONLY Sprint-3 forecasting reads this table.
//
// PLANNED FX IS AN ESTIMATE: the future periodMonth's rate is unknown, so we
// resolve the LATEST manual/live rate AT ENTRY TIME (Sprint-23 resolveRateToBase
// with atDate = entry date, NOT the future month), stamp fxRateDate = that entry
// date + a source flag, and store native + amountBase so it's re-derivable.
// amountBase is NULL (never a guess) when no rate exists — the UI labels these
// figures as estimates.
//
// Gated by the existing `cac` entitlement (ALL_ON). Read = owner/admin/manager;
// write = owner/admin only — enforced on the router (same as Phase 1).
// ============================================================================

import { randomUUID } from "crypto";
import { prisma } from "../config/database";
import { getBaseCurrency, resolveRateToBase, type FxSource } from "./deal-economics.service";
import { AD_PLATFORMS } from "./ad-campaign.service";
import { COST_CATEGORIES } from "./acquisition-cost.service";

export const PLANNED_KINDS = ["ad", "non_ad"] as const;
export type PlannedKind = (typeof PLANNED_KINDS)[number];

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
function toNum(v: unknown): number {
  return v == null ? 0 : Number(v);
}
function toNumOrNull(v: unknown): number | null {
  return v == null ? null : Number(v);
}

/** Parse a YYYY-MM (or YYYY-MM-DD/ISO) string to a UTC first-of-month Date; null
 *  on garbage. Planned rows are bucketed by month, so the day is normalized to 1. */
function parsePeriodMonth(v: unknown): Date | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const m = /^(\d{4})-(\d{2})/.exec(v.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const d = new Date(Date.UTC(y, mo - 1, 1));
  return Number.isNaN(d.getTime()) ? null : d;
}

function dateOnlyStr(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : null;
}

function coerceKind(v: unknown): PlannedKind {
  return (PLANNED_KINDS as readonly string[]).includes(String(v)) ? (v as PlannedKind) : "ad";
}
function normPlatform(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (AD_PLATFORMS as readonly string[]).includes(s) ? s : null;
}
function normCategory(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (COST_CATEGORIES as readonly string[]).includes(s) ? s : null;
}
function normCurrency(v: unknown, fallback: string): string {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return /^[A-Z]{3}$/.test(s) ? s : fallback;
}

export interface PlannedSpend {
  id: string;
  companyId: string;
  periodMonth: string; // YYYY-MM-DD (first of month)
  kind: string;
  platform: string | null;
  category: string | null;
  label: string | null;
  amount: number;
  currency: string;
  amountBase: number | null;
  fxRateToBase: number | null;
  fxRateSource: string | null;
  fxRateDate: string | null;
  note: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const PLANNED_COLS = `
  "id","companyId","periodMonth"::text AS "periodMonth","kind","platform","category",
  "label","amount"::text AS "amount","currency","amountBase"::text AS "amountBase",
  "fxRateToBase"::text AS "fxRateToBase","fxRateSource","fxRateDate"::text AS "fxRateDate",
  "note","createdById","createdAt","updatedAt"
`;

function mapPlanned(r: Record<string, unknown>): PlannedSpend {
  return {
    id: String(r.id),
    companyId: String(r.companyId),
    periodMonth: dateOnlyStr(r.periodMonth) ?? "",
    kind: String(r.kind),
    platform: (r.platform as string | null) ?? null,
    category: (r.category as string | null) ?? null,
    label: (r.label as string | null) ?? null,
    amount: toNum(r.amount),
    currency: String(r.currency),
    amountBase: toNumOrNull(r.amountBase),
    fxRateToBase: toNumOrNull(r.fxRateToBase),
    fxRateSource: (r.fxRateSource as string | null) ?? null,
    fxRateDate: dateOnlyStr(r.fxRateDate),
    note: (r.note as string | null) ?? null,
    createdById: (r.createdById as string | null) ?? null,
    createdAt: r.createdAt as Date,
    updatedAt: r.updatedAt as Date,
  };
}

interface Conversion {
  amountBase: number | null;
  fxRateToBase: number | null;
  fxRateSource: FxSource;
}

// Resolve the ESTIMATE conversion at entry time (the future month's rate is
// unknown). atDate = now → latest manual/live rate. No rate → amountBase null +
// source 'unavailable'. Reuses the Sprint-23 engine, identical to actual spend.
async function convertEstimate(
  companyId: string,
  amount: number,
  currency: string,
  base: string,
  atDate: Date
): Promise<Conversion> {
  const { rate, source } = await resolveRateToBase(companyId, currency, base, atDate);
  return {
    amountBase: rate != null ? round2(amount * rate) : null,
    fxRateToBase: rate,
    fxRateSource: source,
  };
}

/** Split kind → which of platform/category is meaningful; the other is nulled. */
function splitKindTags(kind: PlannedKind, platform: unknown, category: unknown): { platform: string | null; category: string | null } {
  return kind === "ad"
    ? { platform: normPlatform(platform), category: null }
    : { platform: null, category: normCategory(category) };
}

export async function listPlanned(companyId: string): Promise<PlannedSpend[]> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT ${PLANNED_COLS} FROM planned_acquisition_spend
      WHERE "companyId" = $1
      ORDER BY "periodMonth" DESC, "createdAt" DESC`,
    companyId
  )) as Array<Record<string, unknown>>;
  return rows.map(mapPlanned);
}

export async function getPlanned(companyId: string, id: string): Promise<PlannedSpend | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT ${PLANNED_COLS} FROM planned_acquisition_spend
      WHERE "companyId" = $1 AND "id" = $2 LIMIT 1`,
    companyId,
    id
  )) as Array<Record<string, unknown>>;
  return rows[0] ? mapPlanned(rows[0]) : null;
}

export interface PlannedInput {
  periodMonth?: string;
  kind?: string;
  platform?: string | null;
  category?: string | null;
  label?: string | null;
  amount?: number;
  currency?: string;
  note?: string | null;
}

export class PlannedValidationError extends Error {}

/**
 * Add a planned-spend row. currency may be base (TRY) directly or any native
 * currency — converted to an ESTIMATE at entry time either way. Throws
 * PlannedValidationError on a bad amount/periodMonth.
 */
export async function addPlanned(
  companyId: string,
  createdById: string | null,
  input: PlannedInput
): Promise<PlannedSpend> {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new PlannedValidationError("amount must be a non-negative number");
  }
  const period = parsePeriodMonth(input.periodMonth);
  if (!period) throw new PlannedValidationError("periodMonth must be YYYY-MM");

  const kind = coerceKind(input.kind);
  const { platform, category } = splitKindTags(kind, input.platform, input.category);
  const base = await getBaseCurrency(companyId);
  const currency = normCurrency(input.currency, base);
  const conv = await convertEstimate(companyId, round2(amount), currency, base, new Date());

  const id = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO planned_acquisition_spend
       ("id","companyId","periodMonth","kind","platform","category","label",
        "amount","currency","amountBase","fxRateToBase","fxRateSource","fxRateDate",
        "note","createdById","createdAt","updatedAt")
     VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::date,$14,$15,NOW(),NOW())`,
    id,
    companyId,
    period.toISOString().slice(0, 10),
    kind,
    platform,
    category,
    (input.label ?? "").trim() || null,
    round2(amount),
    currency,
    conv.amountBase,
    conv.fxRateToBase,
    conv.fxRateSource,
    new Date().toISOString().slice(0, 10),
    input.note ?? null,
    createdById
  );
  return (await getPlanned(companyId, id))!;
}

/**
 * Edit a planned-spend row. If amount / currency change, the estimate conversion
 * is re-struck at entry time (now). Returns null when the row doesn't exist for
 * this company; throws PlannedValidationError on bad input.
 */
export async function updatePlanned(
  companyId: string,
  id: string,
  patch: PlannedInput
): Promise<PlannedSpend | null> {
  const current = await getPlanned(companyId, id);
  if (!current) return null;

  const amount = patch.amount !== undefined ? Number(patch.amount) : current.amount;
  if (!Number.isFinite(amount) || amount < 0) {
    throw new PlannedValidationError("amount must be a non-negative number");
  }
  let period: Date;
  if (patch.periodMonth !== undefined) {
    const p = parsePeriodMonth(patch.periodMonth);
    if (!p) throw new PlannedValidationError("periodMonth must be YYYY-MM");
    period = p;
  } else {
    period = parsePeriodMonth(current.periodMonth) ?? new Date();
  }
  const kind = patch.kind !== undefined ? coerceKind(patch.kind) : (current.kind as PlannedKind);
  const { platform, category } = splitKindTags(
    kind,
    patch.platform !== undefined ? patch.platform : current.platform,
    patch.category !== undefined ? patch.category : current.category
  );
  const label = patch.label !== undefined ? ((patch.label ?? "").trim() || null) : current.label;
  const currency =
    patch.currency !== undefined ? normCurrency(patch.currency, current.currency) : current.currency;

  const base = await getBaseCurrency(companyId);
  const conv = await convertEstimate(companyId, round2(amount), currency, base, new Date());
  const note = patch.note !== undefined ? patch.note : current.note;

  await prisma.$executeRawUnsafe(
    `UPDATE planned_acquisition_spend
       SET "periodMonth" = $3::date, "kind" = $4, "platform" = $5, "category" = $6,
           "label" = $7, "amount" = $8, "currency" = $9, "amountBase" = $10,
           "fxRateToBase" = $11, "fxRateSource" = $12, "fxRateDate" = $13::date,
           "note" = $14, "updatedAt" = NOW()
     WHERE "companyId" = $1 AND "id" = $2`,
    companyId,
    id,
    period.toISOString().slice(0, 10),
    kind,
    platform,
    category,
    label,
    round2(amount),
    currency,
    conv.amountBase,
    conv.fxRateToBase,
    conv.fxRateSource,
    new Date().toISOString().slice(0, 10),
    note ?? null
  );
  return getPlanned(companyId, id);
}

export async function deletePlanned(companyId: string, id: string): Promise<boolean> {
  const n = await prisma.$executeRawUnsafe(
    `DELETE FROM planned_acquisition_spend WHERE "companyId" = $1 AND "id" = $2`,
    companyId,
    id
  );
  return Number(n) > 0;
}
