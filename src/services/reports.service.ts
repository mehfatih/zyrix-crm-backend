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

// ============================================================================
// E-COMMERCE ANALYTICS
// ----------------------------------------------------------------------------
// Per-platform customer and order rollups. All Deal-derived revenue is
// normalized to the company's base currency via buildRateMap. Growth numbers
// compare the last `windowDays` against the same-length window before that
// so the UI can show trends without the caller needing to think in ranges.
//
// We key by Customer.source (populated on every upsert by ecommerce.service
// as either 'shopify', 'salla', etc., or null for CRM-native customers) and
// by the dedup pattern '{platform} order #{id}' on Deal.title set by
// upsertOrderDeal, so stats stay correct regardless of whether the data
// arrived via polling sync or webhooks.
// ============================================================================

export async function getEcommerceAnalytics(
  companyId: string,
  baseCurrency: string = "USD",
  windowDays: number = 30
) {
  const base = baseCurrency.toUpperCase();
  const rateMap = await buildRateMap(companyId);
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const priorStart = new Date(
    now.getTime() - 2 * windowDays * 24 * 60 * 60 * 1000
  );

  // ─── Connected stores (ground truth for platform list) ─────────────
  const stores = await prisma.ecommerceStore.findMany({
    where: { companyId, isActive: true },
    select: {
      id: true,
      platform: true,
      shopDomain: true,
      lastSyncAt: true,
      syncStatus: true,
      totalCustomersImported: true,
      totalOrdersImported: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  // ─── Customer rollup keyed by source ───────────────────────────────
  // Fetch all non-null source customers with essentials for LTV + top-spenders
  const customers = await prisma.customer.findMany({
    where: {
      companyId,
      source: { not: null },
    },
    select: {
      id: true,
      fullName: true,
      email: true,
      source: true,
      lifetimeValue: true,
      createdAt: true,
    },
  });

  // ─── Order-deals keyed by platform prefix in title ─────────────────
  // Dedup pattern is '{platform} order #{id}' in upsertOrderDeal, so a
  // simple startsWith filter is the cheap + correct way to partition.
  const orderDeals = await prisma.deal.findMany({
    where: {
      companyId,
      title: { contains: " order #" },
    },
    select: {
      id: true,
      title: true,
      stage: true,
      value: true,
      currency: true,
      actualCloseDate: true,
      createdAt: true,
    },
  });

  // Infer platform from title prefix
  const platformFromTitle = (title: string): string | null => {
    const m = title.match(/^([a-zA-Z0-9_-]+) order #/);
    return m ? m[1] : null;
  };

  // ─── Aggregate per-platform ────────────────────────────────────────
  interface PlatformBucket {
    platform: string;
    storesConnected: number;
    customers: number;
    customersInWindow: number;
    customersInPriorWindow: number;
    orders: number;
    ordersInWindow: number;
    wonOrders: number;
    wonRevenue: number; // in base currency
    avgOrderValue: number; // in base currency
  }

  const byPlatform = new Map<string, PlatformBucket>();
  const seenPlatforms = new Set<string>();

  // seed from connected stores so platforms with zero data still appear
  for (const s of stores) {
    seenPlatforms.add(s.platform);
    if (!byPlatform.has(s.platform)) {
      byPlatform.set(s.platform, {
        platform: s.platform,
        storesConnected: 0,
        customers: 0,
        customersInWindow: 0,
        customersInPriorWindow: 0,
        orders: 0,
        ordersInWindow: 0,
        wonOrders: 0,
        wonRevenue: 0,
        avgOrderValue: 0,
      });
    }
    byPlatform.get(s.platform)!.storesConnected++;
  }

  // customers
  for (const c of customers) {
    const platform = c.source || "other";
    if (!byPlatform.has(platform)) {
      byPlatform.set(platform, {
        platform,
        storesConnected: 0,
        customers: 0,
        customersInWindow: 0,
        customersInPriorWindow: 0,
        orders: 0,
        ordersInWindow: 0,
        wonOrders: 0,
        wonRevenue: 0,
        avgOrderValue: 0,
      });
    }
    const b = byPlatform.get(platform)!;
    b.customers++;
    if (c.createdAt >= windowStart) b.customersInWindow++;
    else if (c.createdAt >= priorStart) b.customersInPriorWindow++;
  }

  // orders
  for (const d of orderDeals) {
    const platform = platformFromTitle(d.title);
    if (!platform) continue;
    if (!byPlatform.has(platform)) {
      byPlatform.set(platform, {
        platform,
        storesConnected: 0,
        customers: 0,
        customersInWindow: 0,
        customersInPriorWindow: 0,
        orders: 0,
        ordersInWindow: 0,
        wonOrders: 0,
        wonRevenue: 0,
        avgOrderValue: 0,
      });
    }
    const b = byPlatform.get(platform)!;
    b.orders++;
    const refDate = d.actualCloseDate || d.createdAt;
    if (refDate >= windowStart) b.ordersInWindow++;
    if (d.stage === "won") {
      b.wonOrders++;
      b.wonRevenue += convert(Number(d.value), d.currency, base, rateMap);
    }
  }
  // avgOrderValue
  for (const b of byPlatform.values()) {
    b.avgOrderValue = b.wonOrders > 0 ? b.wonRevenue / b.wonOrders : 0;
  }

  // ─── Top 10 customers by LTV, cross-platform ───────────────────────
  const topCustomers = [...customers]
    .sort((a, b) => Number(b.lifetimeValue) - Number(a.lifetimeValue))
    .slice(0, 10)
    .map((c) => ({
      id: c.id,
      fullName: c.fullName,
      email: c.email,
      source: c.source,
      lifetimeValue: Number(c.lifetimeValue),
    }));

  // ─── Daily time series (won revenue) for the last windowDays ──────
  const dailyMap = new Map<string, number>();
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    dailyMap.set(key, 0);
  }
  for (const d of orderDeals) {
    if (d.stage !== "won") continue;
    const ref = d.actualCloseDate || d.createdAt;
    if (ref < windowStart) continue;
    const key = ref.toISOString().slice(0, 10);
    if (dailyMap.has(key)) {
      dailyMap.set(
        key,
        dailyMap.get(key)! + convert(Number(d.value), d.currency, base, rateMap)
      );
    }
  }
  const dailyRevenue = Array.from(dailyMap.entries()).map(([date, revenue]) => ({
    date,
    revenue: Math.round(revenue * 100) / 100,
  }));

  // ─── Global totals ─────────────────────────────────────────────────
  let totalCustomers = 0;
  let totalCustomersInWindow = 0;
  let totalCustomersInPriorWindow = 0;
  let totalOrders = 0;
  let totalWonRevenue = 0;
  for (const b of byPlatform.values()) {
    totalCustomers += b.customers;
    totalCustomersInWindow += b.customersInWindow;
    totalCustomersInPriorWindow += b.customersInPriorWindow;
    totalOrders += b.orders;
    totalWonRevenue += b.wonRevenue;
  }
  const customerGrowthPct =
    totalCustomersInPriorWindow > 0
      ? ((totalCustomersInWindow - totalCustomersInPriorWindow) /
          totalCustomersInPriorWindow) *
        100
      : totalCustomersInWindow > 0
        ? 100
        : 0;

  return {
    baseCurrency: base,
    windowDays,
    generatedAt: now.toISOString(),
    totals: {
      storesConnected: stores.length,
      totalCustomers,
      totalCustomersInWindow,
      totalCustomersInPriorWindow,
      customerGrowthPct: Math.round(customerGrowthPct * 10) / 10,
      totalOrders,
      totalWonRevenue: Math.round(totalWonRevenue * 100) / 100,
    },
    platforms: Array.from(byPlatform.values())
      .map((b) => ({
        ...b,
        wonRevenue: Math.round(b.wonRevenue * 100) / 100,
        avgOrderValue: Math.round(b.avgOrderValue * 100) / 100,
      }))
      .sort((a, b) => b.wonRevenue - a.wonRevenue),
    topCustomers,
    dailyRevenue,
    stores: stores.map((s) => ({
      id: s.id,
      platform: s.platform,
      shopDomain: s.shopDomain,
      lastSyncAt: s.lastSyncAt,
      syncStatus: s.syncStatus,
      totalCustomersImported: s.totalCustomersImported,
      totalOrdersImported: s.totalOrdersImported,
    })),
  };
}
