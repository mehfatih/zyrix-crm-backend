// ============================================================================
// ACQUISITION COSTS (CAC Sprint 2, Phase 1) — non-ad acquisition/marketing/sales
// cost ledger (raw SQL, tenant-scoped).
// ----------------------------------------------------------------------------
// The merchant's NON-AD acquisition costs — sales-rep salaries/commissions
// attributable to acquisition, agency retainers, events/booths, content,
// tooling, any manual cost — so blended CAC reflects TRUE total acquisition cost,
// not just ad spend. These costs often map to no ad campaign/platform.
//
// SEPARATE from ad_spend_entries BY DESIGN: actual ad spend (Sprint 24) stays
// untouched, so Sprint-1 CAC and Sprint-24 ROAS/CPA are provably unchanged. CAC
// folds this ledger into its blended figure via one additive (guarded) SUM.
//
// Raw-SQL table `acquisition_costs` (NO Prisma model, accessed via
// $queryRawUnsafe — mirrors the Sprint 18/19/20/24 convention). FX → base (TRY)
// reuses the Sprint-23 resolveRateToBase engine verbatim, frozen at costDate;
// amountBase is NULL (never a guess) when no rate exists — the same "set an
// exchange rate" honesty as deal & campaign economics.
//
// Gated by the existing `cac` entitlement (ALL_ON). Read = owner/admin/manager;
// write = owner/admin only (salaries/commissions are sensitive) — enforced on
// the router.
// ============================================================================

import { randomUUID } from "crypto";
import { prisma } from "../config/database";
import { getBaseCurrency, resolveRateToBase, type FxSource } from "./deal-economics.service";
import { AD_PLATFORMS } from "./ad-campaign.service";

// Cost categories. Free-text in the DB; validated here + in the zod layer. The
// frontend renders trilingual labels keyed by these values.
export const COST_CATEGORIES = [
  "salary", // sales-rep salary attributable to acquisition
  "commission", // sales commission (non-deal-linked acquisition cost)
  "agency", // agency / freelancer retainer
  "event", // events / booths / sponsorships
  "content", // content / creative production
  "tooling", // marketing/sales tooling & software
  "other",
] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
function toNum(v: unknown): number {
  return v == null ? 0 : Number(v);
}
function toNumOrNull(v: unknown): number | null {
  return v == null ? null : Number(v);
}

/** Parse a YYYY-MM-DD (or ISO) string to a UTC-midnight Date; null on garbage. */
function parseDateOnly(v: unknown): Date | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

function dateOnlyStr(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : null;
}

function coerceCategory(v: unknown): CostCategory {
  return (COST_CATEGORIES as readonly string[]).includes(String(v)) ? (v as CostCategory) : "other";
}

/** Normalize a channel tag to a known ad platform, else null (untagged → the
 *  "non_ad" bucket in per-channel CAC). Reuses the shared AD_PLATFORMS vocabulary
 *  so a tagged cost rolls into the same platform bucket as ad spend. */
function normChannel(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (AD_PLATFORMS as readonly string[]).includes(s) ? s : null;
}

function normCurrency(v: unknown, fallback: string): string {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return /^[A-Z]{3}$/.test(s) ? s : fallback;
}

export interface AcquisitionCost {
  id: string;
  companyId: string;
  costDate: string; // YYYY-MM-DD
  category: string;
  channel: string | null;
  amount: number;
  currency: string;
  amountBase: number | null;
  fxRateToBase: number | null;
  fxRateSource: string | null;
  fxRateDate: string | null;
  entryMode: string;
  note: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const COST_COLS = `
  "id","companyId","costDate"::text AS "costDate","category","channel",
  "amount"::text AS "amount","currency","amountBase"::text AS "amountBase",
  "fxRateToBase"::text AS "fxRateToBase","fxRateSource","fxRateDate"::text AS "fxRateDate",
  "entryMode","note","createdById","createdAt","updatedAt"
`;

function mapCost(r: Record<string, unknown>): AcquisitionCost {
  return {
    id: String(r.id),
    companyId: String(r.companyId),
    costDate: dateOnlyStr(r.costDate) ?? "",
    category: String(r.category),
    channel: (r.channel as string | null) ?? null,
    amount: toNum(r.amount),
    currency: String(r.currency),
    amountBase: toNumOrNull(r.amountBase),
    fxRateToBase: toNumOrNull(r.fxRateToBase),
    fxRateSource: (r.fxRateSource as string | null) ?? null,
    fxRateDate: dateOnlyStr(r.fxRateDate),
    entryMode: String(r.entryMode),
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

// Convert a native cost amount to base currency, frozen at costDate. TRY-direct
// (currency === base) returns source 'same'/rate 1; otherwise the Sprint-23 FX
// engine resolves (manual override → live at-date). No rate → amountBase null +
// source 'unavailable' (honest "set a rate", never a guess). Identical to the
// Sprint-24 convertSpend.
async function convertCost(
  companyId: string,
  amount: number,
  currency: string,
  base: string,
  costDate: Date
): Promise<Conversion> {
  const { rate, source } = await resolveRateToBase(companyId, currency, base, costDate);
  return {
    amountBase: rate != null ? round2(amount * rate) : null,
    fxRateToBase: rate,
    fxRateSource: source,
  };
}

export async function listCosts(companyId: string): Promise<AcquisitionCost[]> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT ${COST_COLS} FROM acquisition_costs
      WHERE "companyId" = $1
      ORDER BY "costDate" DESC, "createdAt" DESC`,
    companyId
  )) as Array<Record<string, unknown>>;
  return rows.map(mapCost);
}

export async function getCost(companyId: string, id: string): Promise<AcquisitionCost | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT ${COST_COLS} FROM acquisition_costs
      WHERE "companyId" = $1 AND "id" = $2 LIMIT 1`,
    companyId,
    id
  )) as Array<Record<string, unknown>>;
  return rows[0] ? mapCost(rows[0]) : null;
}

export interface CostInput {
  costDate?: string;
  category?: string;
  channel?: string | null;
  amount?: number;
  currency?: string;
  note?: string | null;
}

export class CostValidationError extends Error {}

/**
 * Add a non-ad acquisition cost. The currency may be base (TRY) directly or any
 * native currency — converted + frozen at costDate either way. Throws
 * CostValidationError on a bad amount/date.
 */
export async function addCost(
  companyId: string,
  createdById: string | null,
  input: CostInput
): Promise<AcquisitionCost> {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new CostValidationError("amount must be a non-negative number");
  }
  const costDate = parseDateOnly(input.costDate);
  if (!costDate) throw new CostValidationError("costDate must be YYYY-MM-DD");

  const category = coerceCategory(input.category);
  const channel = normChannel(input.channel);
  const base = await getBaseCurrency(companyId);
  const currency = normCurrency(input.currency, base);
  const conv = await convertCost(companyId, round2(amount), currency, base, costDate);

  const id = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO acquisition_costs
       ("id","companyId","costDate","category","channel","amount","currency",
        "amountBase","fxRateToBase","fxRateSource","fxRateDate","entryMode",
        "note","createdById","createdAt","updatedAt")
     VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,$11::date,'manual',$12,$13,NOW(),NOW())`,
    id,
    companyId,
    costDate.toISOString().slice(0, 10),
    category,
    channel,
    round2(amount),
    currency,
    conv.amountBase,
    conv.fxRateToBase,
    conv.fxRateSource,
    costDate.toISOString().slice(0, 10),
    input.note ?? null,
    createdById
  );
  return (await getCost(companyId, id))!;
}

/**
 * Edit a cost. If amount / currency / costDate change, the base-currency
 * conversion is re-frozen at the (new) costDate. Returns null when the entry
 * doesn't exist for this company; throws CostValidationError on bad input.
 */
export async function updateCost(
  companyId: string,
  id: string,
  patch: CostInput
): Promise<AcquisitionCost | null> {
  const current = await getCost(companyId, id);
  if (!current) return null;

  const amount = patch.amount !== undefined ? Number(patch.amount) : current.amount;
  if (!Number.isFinite(amount) || amount < 0) {
    throw new CostValidationError("amount must be a non-negative number");
  }
  let costDate: Date;
  if (patch.costDate !== undefined) {
    const d = parseDateOnly(patch.costDate);
    if (!d) throw new CostValidationError("costDate must be YYYY-MM-DD");
    costDate = d;
  } else {
    costDate = parseDateOnly(current.costDate) ?? new Date();
  }
  const category = patch.category !== undefined ? coerceCategory(patch.category) : current.category;
  const channel = patch.channel !== undefined ? normChannel(patch.channel) : current.channel;
  const currency =
    patch.currency !== undefined ? normCurrency(patch.currency, current.currency) : current.currency;

  const base = await getBaseCurrency(companyId);
  const conv = await convertCost(companyId, round2(amount), currency, base, costDate);
  const note = patch.note !== undefined ? patch.note : current.note;

  await prisma.$executeRawUnsafe(
    `UPDATE acquisition_costs
       SET "costDate" = $3::date, "category" = $4, "channel" = $5, "amount" = $6,
           "currency" = $7, "amountBase" = $8, "fxRateToBase" = $9, "fxRateSource" = $10,
           "fxRateDate" = $3::date, "note" = $11, "updatedAt" = NOW()
     WHERE "companyId" = $1 AND "id" = $2`,
    companyId,
    id,
    costDate.toISOString().slice(0, 10),
    category,
    channel,
    round2(amount),
    currency,
    conv.amountBase,
    conv.fxRateToBase,
    conv.fxRateSource,
    note ?? null
  );
  return getCost(companyId, id);
}

export async function deleteCost(companyId: string, id: string): Promise<boolean> {
  const n = await prisma.$executeRawUnsafe(
    `DELETE FROM acquisition_costs WHERE "companyId" = $1 AND "id" = $2`,
    companyId,
    id
  );
  return Number(n) > 0;
}
