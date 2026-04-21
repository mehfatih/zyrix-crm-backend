import { prisma } from "../config/database";
import { notFound } from "../middleware/errorHandler";
import type { Prisma } from "@prisma/client";

// ============================================================================
// MULTI-CURRENCY REPORTS SERVICE
// Uses per-company exchange rates to normalize all values to a base currency
// ============================================================================

export interface ExchangeRateDto {
  fromCurrency: string;
  toCurrency: string;
  rate: number;
}

// Default built-in rates (fallback when company has no rates configured)
// Rates are TO USD — used to convert anything into USD as a cross-pair
const DEFAULT_RATES_TO_USD: Record<string, number> = {
  USD: 1.0,
  EUR: 1.08,
  GBP: 1.27,
  TRY: 0.031,
  SAR: 0.27,
  AED: 0.272,
  EGP: 0.021,
  QAR: 0.275,
  KWD: 3.26,
  IQD: 0.00076,
};

// ─────────────────────────────────────────────────────────────────────────
// EXCHANGE RATES CRUD
// ─────────────────────────────────────────────────────────────────────────
export async function listRates(companyId: string) {
  return prisma.exchangeRate.findMany({
    where: { companyId },
    orderBy: [{ fromCurrency: "asc" }, { toCurrency: "asc" }],
  });
}

export async function upsertRate(
  companyId: string,
  dto: ExchangeRateDto
) {
  const from = dto.fromCurrency.toUpperCase().trim();
  const to = dto.toCurrency.toUpperCase().trim();
  if (from === to) {
    const err: any = new Error("From and to currencies must differ");
    err.statusCode = 400;
    throw err;
  }
  if (dto.rate <= 0) {
    const err: any = new Error("Rate must be > 0");
    err.statusCode = 400;
    throw err;
  }

  return prisma.exchangeRate.upsert({
    where: {
      companyId_fromCurrency_toCurrency: {
        companyId,
        fromCurrency: from,
        toCurrency: to,
      },
    },
    create: {
      companyId,
      fromCurrency: from,
      toCurrency: to,
      rate: dto.rate,
      effectiveAt: new Date(),
    },
    update: {
      rate: dto.rate,
      effectiveAt: new Date(),
    },
  });
}

export async function deleteRate(companyId: string, id: string) {
  const existing = await prisma.exchangeRate.findFirst({
    where: { id, companyId },
    select: { id: true },
  });
  if (!existing) throw notFound("Exchange rate");
  await prisma.exchangeRate.delete({ where: { id } });
  return { deleted: true };
}

// ─────────────────────────────────────────────────────────────────────────
// CONVERSION ENGINE
// ─────────────────────────────────────────────────────────────────────────
export async function buildRateMap(companyId: string) {
  const rates = await prisma.exchangeRate.findMany({
    where: { companyId },
  });
  const map = new Map<string, number>(); // key: "FROM->TO", value: rate
  for (const r of rates) {
    map.set(`${r.fromCurrency}->${r.toCurrency}`, Number(r.rate));
  }
  return map;
}

export function convert(
  amount: number,
  from: string,
  to: string,
  rateMap: Map<string, number>
): number {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) return amount;

  // Direct match
  const direct = rateMap.get(`${f}->${t}`);
  if (direct) return amount * direct;

  // Inverse
  const inverse = rateMap.get(`${t}->${f}`);
  if (inverse && inverse !== 0) return amount / inverse;

  // Via USD default bridge
  const fromToUsd = DEFAULT_RATES_TO_USD[f];
  const toToUsd = DEFAULT_RATES_TO_USD[t];
  if (fromToUsd && toToUsd) {
    return (amount * fromToUsd) / toToUsd;
  }

  // No conversion possible — return original (caller should warn)
  return amount;
}

// ─────────────────────────────────────────────────────────────────────────
// REVENUE REPORT — all won deals normalized to target currency
// ─────────────────────────────────────────────────────────────────────────
export async function getRevenueReport(
  companyId: string,
  baseCurrency: string = "USD",
  since?: Date
) {
  const base = baseCurrency.toUpperCase();
  const rateMap = await buildRateMap(companyId);

  const where: Prisma.DealWhereInput = {
    companyId,
    stage: "won",
  };
  if (since) where.actualCloseDate = { gte: since };

  const deals = await prisma.deal.findMany({
    where,
    select: {
      id: true,
      title: true,
      value: true,
      currency: true,
      actualCloseDate: true,
      owner: { select: { id: true, fullName: true } },
      customer: { select: { id: true, fullName: true } },
    },
    orderBy: { actualCloseDate: "desc" },
  });

  const byCurrency: Record<
    string,
    { count: number; native: number; converted: number }
  > = {};
  let totalConverted = 0;
  const unconvertible: string[] = [];

  for (const d of deals) {
    const value = Number(d.value);
    const converted = convert(value, d.currency, base, rateMap);
    const same = d.currency.toUpperCase() === base;
    if (!same && converted === value) {
      // convert() returned original → no rate found
      unconvertible.push(d.currency);
    }

    const entry = byCurrency[d.currency] ?? {
      count: 0,
      native: 0,
      converted: 0,
    };
    entry.count++;
    entry.native += value;
    entry.converted += converted;
    byCurrency[d.currency] = entry;

    totalConverted += converted;
  }

  // Roundings
  for (const k of Object.keys(byCurrency)) {
    byCurrency[k].native = Math.round(byCurrency[k].native * 100) / 100;
    byCurrency[k].converted =
      Math.round(byCurrency[k].converted * 100) / 100;
  }

  return {
    baseCurrency: base,
    totalRevenue: Math.round(totalConverted * 100) / 100,
    dealCount: deals.length,
    byCurrency,
    unconvertibleCurrencies: Array.from(new Set(unconvertible)),
    deals: deals.slice(0, 50).map((d) => ({
      ...d,
      value: Number(d.value),
      convertedValue:
        Math.round(convert(Number(d.value), d.currency, base, rateMap) * 100) /
        100,
    })),
    generatedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// PIPELINE REPORT — open deals normalized by stage
// ─────────────────────────────────────────────────────────────────────────
export async function getPipelineReport(
  companyId: string,
  baseCurrency: string = "USD"
) {
  const base = baseCurrency.toUpperCase();
  const rateMap = await buildRateMap(companyId);

  const deals = await prisma.deal.findMany({
    where: { companyId, stage: { notIn: ["won", "lost"] } },
    select: {
      stage: true,
      value: true,
      currency: true,
      probability: true,
    },
  });

  const byStage: Record<
    string,
    { count: number; value: number; weightedValue: number }
  > = {};
  let totalValue = 0;
  let totalWeighted = 0;

  for (const d of deals) {
    const v = convert(Number(d.value), d.currency, base, rateMap);
    const weighted = (v * d.probability) / 100;
    const s = byStage[d.stage] ?? { count: 0, value: 0, weightedValue: 0 };
    s.count++;
    s.value += v;
    s.weightedValue += weighted;
    byStage[d.stage] = s;
    totalValue += v;
    totalWeighted += weighted;
  }

  for (const k of Object.keys(byStage)) {
    byStage[k].value = Math.round(byStage[k].value * 100) / 100;
    byStage[k].weightedValue =
      Math.round(byStage[k].weightedValue * 100) / 100;
  }

  return {
    baseCurrency: base,
    totalOpenValue: Math.round(totalValue * 100) / 100,
    totalWeightedValue: Math.round(totalWeighted * 100) / 100,
    dealCount: deals.length,
    byStage,
    generatedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// FULL FINANCIAL SUMMARY
// ─────────────────────────────────────────────────────────────────────────
export async function getFinancialSummary(
  companyId: string,
  baseCurrency: string = "USD"
) {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  const [revenue30d, revenue90d, pipeline] = await Promise.all([
    getRevenueReport(companyId, baseCurrency, thirtyDaysAgo),
    getRevenueReport(companyId, baseCurrency, ninetyDaysAgo),
    getPipelineReport(companyId, baseCurrency),
  ]);

  return {
    baseCurrency: baseCurrency.toUpperCase(),
    revenue30d: {
      total: revenue30d.totalRevenue,
      dealCount: revenue30d.dealCount,
    },
    revenue90d: {
      total: revenue90d.totalRevenue,
      dealCount: revenue90d.dealCount,
    },
    openPipeline: {
      total: pipeline.totalOpenValue,
      weighted: pipeline.totalWeightedValue,
      dealCount: pipeline.dealCount,
    },
    currenciesInUse: Object.keys(revenue90d.byCurrency),
    hasUnconvertible: revenue30d.unconvertibleCurrencies.length > 0,
    generatedAt: new Date().toISOString(),
  };
}
