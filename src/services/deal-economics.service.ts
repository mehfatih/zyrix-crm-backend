// ============================================================================
// DEAL ECONOMICS (Sprint 23) — currency-stamping + COGS + per-deal profit.
// ----------------------------------------------------------------------------
// GOAL: real gross profit per deal in the company's base currency (default TRY),
// reliably, without manual FX guesswork.
//
// Two halves:
//   1. stampDealEconomics()  — called once at CLOSE (deal → won). Freezes a
//      dealCurrency→base FX rate + the base-currency revenue + a COGS roll-up.
//      Frozen pieces (fxRateToBase/Date/Source, baseCurrency, baseValue,
//      cogsBase) NEVER silently change afterwards. Captured for EVERY tenant
//      regardless of plan, so upgrading later lights up historical deals.
//   2. computeDealEconomics() — read-time breakdown for the gated profitability
//      surface. Uses the FROZEN revenue/COGS + LIVE variable costs + LIVE
//      commission (so post-close cost refinements reflect immediately).
//
// FX resolution (locked decision): per-company manual ExchangeRate → live
// FxRate at-date. The hardcoded DEFAULT_RATES guesses used by reports are NEVER
// frozen here. When no real rate exists → fxRateSource='unavailable', baseValue
// null, and the surface badges "set an exchange rate" rather than guessing.
// ============================================================================

import type { Prisma } from "@prisma/client";
import { prisma } from "../config/database";
import { getLiveUsdRate } from "./fx-rates.service";

export const DEFAULT_BASE_CURRENCY = "TRY";

export type FxSource = "same" | "manual" | "live" | "unavailable";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// The company's base/reporting currency. Reuses the existing Company.baseCurrency
// setting (admin-editable); falls back to TRY when unset.
export async function getBaseCurrency(companyId: string): Promise<string> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { baseCurrency: true },
  });
  return (company?.baseCurrency || DEFAULT_BASE_CURRENCY).toUpperCase();
}

// Resolve a `from`→`to` rate at `atDate`: manual company override first (the
// merchant's declared truth), then the live at-date FxRate cross-pair. Returns
// rate=null + source='unavailable' when neither yields a real number — we never
// guess. `atDate` is used only for the live lookup (manual rates are point-in-time).
export async function resolveRateToBase(
  companyId: string,
  from: string,
  to: string,
  atDate: Date
): Promise<{ rate: number | null; source: FxSource }> {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) return { rate: 1, source: "same" };

  // 1) Manual per-company override (direct, then reciprocal).
  const direct = await prisma.exchangeRate.findFirst({
    where: { companyId, fromCurrency: f, toCurrency: t },
    select: { rate: true },
  });
  if (direct && Number(direct.rate) > 0) {
    return { rate: Number(direct.rate), source: "manual" };
  }
  const rev = await prisma.exchangeRate.findFirst({
    where: { companyId, fromCurrency: t, toCurrency: f },
    select: { rate: true },
  });
  if (rev && Number(rev.rate) > 0) {
    return { rate: 1 / Number(rev.rate), source: "manual" };
  }

  // 2) Live FxRate at-date cross-pair: rate = usdRate(to)/usdRate(from).
  const [usdFrom, usdTo] = await Promise.all([
    getLiveUsdRate(f, atDate),
    getLiveUsdRate(t, atDate),
  ]);
  if (usdFrom != null && usdFrom > 0 && usdTo != null && usdTo > 0) {
    return { rate: usdTo / usdFrom, source: "live" };
  }

  return { rate: null, source: "unavailable" };
}

interface CogsResult {
  cogsBase: number | null; // null = no cost data OR a cost currency couldn't be resolved
  itemsTotal: number;
  itemsCosted: number; // line items that carry a unitCost snapshot
  cogsComplete: boolean; // true only when every costed line resolved to base
}

// Roll up COGS in base currency from the per-line cost snapshots. Lines without
// a unitCost are "unknown cost" and simply don't contribute. If a costed line's
// currency can't be converted to base, we return cogsBase=null (an honest
// "incomplete" rather than an understated number).
export async function computeCogsBase(
  companyId: string,
  dealId: string,
  base: string,
  atDate: Date
): Promise<CogsResult> {
  const items = await prisma.dealItem.findMany({
    where: { dealId, companyId },
    select: { qty: true, unitCost: true, costCurrency: true },
  });
  const itemsTotal = items.length;
  const costed = items.filter((i) => i.unitCost != null);
  const itemsCosted = costed.length;

  if (itemsCosted === 0) {
    return { cogsBase: null, itemsTotal, itemsCosted, cogsComplete: false };
  }

  // Sum native cost per currency bucket, then convert each bucket once.
  const byCurrency = new Map<string, number>();
  for (const it of costed) {
    const cur = (it.costCurrency || base).toUpperCase();
    const lineCost = Number(it.qty) * Number(it.unitCost);
    byCurrency.set(cur, (byCurrency.get(cur) ?? 0) + lineCost);
  }

  let total = 0;
  for (const [cur, sum] of byCurrency) {
    const { rate } = await resolveRateToBase(companyId, cur, base, atDate);
    if (rate == null) {
      // Can't honestly convert this bucket → COGS is incomplete.
      return { cogsBase: null, itemsTotal, itemsCosted, cogsComplete: false };
    }
    total += sum * rate;
  }

  return { cogsBase: round2(total), itemsTotal, itemsCosted, cogsComplete: true };
}

// Freeze the deal's economics at close. Called fire-and-forget from the won
// transition (non-fatal). On first stamp it resolves + freezes the FX rate +
// base revenue. On a re-stamp (deal already stamped, e.g. line items changed)
// it KEEPS the original frozen FX rate/revenue and only refreshes cogsBase —
// the close-time rate is the truth and must not drift.
export async function stampDealEconomics(
  companyId: string,
  dealId: string,
  closeDate?: Date
): Promise<void> {
  const deal = await prisma.deal.findFirst({
    where: { id: dealId, companyId },
    select: {
      id: true,
      value: true,
      currency: true,
      baseCurrency: true,
      fxRateToBase: true,
      fxRateDate: true,
      economicsStampedAt: true,
    },
  });
  if (!deal) return;

  const alreadyStamped = deal.economicsStampedAt != null;
  const base = alreadyStamped && deal.baseCurrency
    ? deal.baseCurrency.toUpperCase()
    : await getBaseCurrency(companyId);
  // Re-stamps reuse the original rate date so COGS stays consistent with the
  // frozen revenue; first stamps use the close date (default: now).
  const rateDate = alreadyStamped && deal.fxRateDate ? deal.fxRateDate : (closeDate ?? new Date());

  if (alreadyStamped) {
    // Keep frozen FX + revenue; only refresh the COGS roll-up.
    const cogs = await computeCogsBase(companyId, dealId, base, rateDate);
    await prisma.deal.update({
      where: { id: dealId },
      data: { cogsBase: cogs.cogsBase },
    });
    return;
  }

  const value = Number(deal.value);
  const { rate, source } = await resolveRateToBase(companyId, deal.currency, base, rateDate);
  const baseValue = rate != null ? round2(value * rate) : null;
  const cogs = await computeCogsBase(companyId, dealId, base, rateDate);

  await prisma.deal.update({
    where: { id: dealId },
    data: {
      baseCurrency: base,
      fxRateToBase: rate,
      fxRateDate: rateDate,
      fxRateSource: source,
      baseValue,
      cogsBase: cogs.cogsBase,
      economicsStampedAt: new Date(),
    },
  });
}

export interface DealEconomics {
  stamped: boolean;
  baseCurrency: string;
  dealCurrency: string;
  dealValue: number;
  fxRateToBase: number | null;
  fxRateDate: string | null;
  fxRateSource: FxSource | null;
  fxAvailable: boolean; // false → surface a "set an exchange rate" badge
  // All amounts below are in baseCurrency.
  baseRevenue: number | null;
  cogs: number | null;
  cogsComplete: boolean;
  itemsTotal: number;
  itemsCosted: number;
  variableCosts: {
    shipping: number;
    paymentFee: number;
    adSpend: number;
    other: number;
    total: number;
  };
  commission: number; // non-cancelled commission, converted via the frozen rate
  grossProfit: number | null;
  marginPct: number | null;
}

// Read-time profitability breakdown for the gated surface. Uses FROZEN revenue +
// COGS and LIVE variable costs + commission. Returns nulls (never guesses) when
// the deal was closed without a resolvable rate.
export async function computeDealEconomics(
  companyId: string,
  dealId: string
): Promise<DealEconomics | null> {
  const deal = await prisma.deal.findFirst({
    where: { id: dealId, companyId },
    select: {
      value: true,
      currency: true,
      baseCurrency: true,
      fxRateToBase: true,
      fxRateDate: true,
      fxRateSource: true,
      baseValue: true,
      cogsBase: true,
      costShipping: true,
      costPaymentFee: true,
      costAdSpend: true,
      costOther: true,
      economicsStampedAt: true,
    },
  });
  if (!deal) return null;

  const base = (deal.baseCurrency || (await getBaseCurrency(companyId))).toUpperCase();
  const rate = deal.fxRateToBase != null ? Number(deal.fxRateToBase) : null;
  const fxAvailable = rate != null;

  // Commission entries are stored in the deal's native currency; convert via the
  // frozen rate. Cancelled entries are excluded.
  const commAgg = await prisma.commissionEntry.aggregate({
    where: { companyId, dealId, status: { not: "cancelled" } },
    _sum: { amount: true },
  });
  const commissionNative = Number(commAgg._sum.amount ?? 0);
  const commission = fxAvailable ? round2(commissionNative * rate!) : 0;

  // COGS completeness re-derived for the read surface (cheap; reflects current lines).
  const cogsInfo = await computeCogsBase(companyId, dealId, base, deal.fxRateDate ?? new Date());

  const shipping = Number(deal.costShipping);
  const paymentFee = Number(deal.costPaymentFee);
  const adSpend = Number(deal.costAdSpend);
  const other = Number(deal.costOther);
  const variableTotal = round2(shipping + paymentFee + adSpend + other);

  const baseRevenue = deal.baseValue != null ? Number(deal.baseValue) : null;
  const cogs = deal.cogsBase != null ? Number(deal.cogsBase) : null;

  let grossProfit: number | null = null;
  let marginPct: number | null = null;
  if (baseRevenue != null) {
    grossProfit = round2(baseRevenue - (cogs ?? 0) - variableTotal - commission);
    marginPct = baseRevenue !== 0 ? round2((grossProfit / baseRevenue) * 100) : null;
  }

  return {
    stamped: deal.economicsStampedAt != null,
    baseCurrency: base,
    dealCurrency: deal.currency.toUpperCase(),
    dealValue: Number(deal.value),
    fxRateToBase: rate,
    fxRateDate: deal.fxRateDate ? deal.fxRateDate.toISOString().slice(0, 10) : null,
    fxRateSource: (deal.fxRateSource as FxSource | null) ?? null,
    fxAvailable,
    baseRevenue,
    cogs,
    cogsComplete: cogsInfo.cogsComplete,
    itemsTotal: cogsInfo.itemsTotal,
    itemsCosted: cogsInfo.itemsCosted,
    variableCosts: { shipping, paymentFee, adSpend, other, total: variableTotal },
    commission,
    grossProfit,
    marginPct,
  };
}

export interface VariableCostsDto {
  shipping?: number;
  paymentFee?: number;
  adSpend?: number;
  other?: number;
}

// Update the merchant-editable variable costs (entered in base currency).
// Partial; only provided fields change. Returns the recomputed breakdown, or
// null when the deal doesn't exist for this company.
export async function updateVariableCosts(
  companyId: string,
  dealId: string,
  dto: VariableCostsDto
): Promise<DealEconomics | null> {
  const existing = await prisma.deal.findFirst({
    where: { id: dealId, companyId },
    select: { id: true },
  });
  if (!existing) return null;

  const data: Prisma.DealUpdateInput = {};
  if (dto.shipping !== undefined) data.costShipping = dto.shipping;
  if (dto.paymentFee !== undefined) data.costPaymentFee = dto.paymentFee;
  if (dto.adSpend !== undefined) data.costAdSpend = dto.adSpend;
  if (dto.other !== undefined) data.costOther = dto.other;

  if (Object.keys(data).length > 0) {
    await prisma.deal.update({ where: { id: dealId }, data });
  }
  return computeDealEconomics(companyId, dealId);
}

// Explicit recompute (e.g. line items changed after close). For a won deal this
// re-stamps: keeps the frozen FX rate/revenue and refreshes COGS, or does a
// first full stamp (at the deal's actual close date) if it was never stamped —
// e.g. deals closed before this feature shipped. Non-won deals are returned as-is.
export async function recomputeDealEconomics(
  companyId: string,
  dealId: string
): Promise<DealEconomics | null> {
  const deal = await prisma.deal.findFirst({
    where: { id: dealId, companyId },
    select: { id: true, stage: true, actualCloseDate: true },
  });
  if (!deal) return null;
  if (deal.stage === "won") {
    await stampDealEconomics(companyId, dealId, deal.actualCloseDate ?? undefined);
  }
  return computeDealEconomics(companyId, dealId);
}
