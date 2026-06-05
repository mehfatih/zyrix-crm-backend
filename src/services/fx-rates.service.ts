// ============================================================================
// LIVE FX RATES (Sprint 15B)
// ----------------------------------------------------------------------------
// Fetches USD-base exchange rates daily from open.er-api.com (keyless) and
// stores one history-preserving row per (base, quote, rateDate). Reports use
// getLiveUsdRate() as the USD bridge in their conversion chain (gated by the
// `live_fx` feature key); when no rate exists callers fall back / badge — they
// never crash and never guess.
//
// er-api gives "units of QUOTE per 1 USD" (rates.TRY = TRY per USD), so:
//   amount_in_to = amount_in_from * (usdRate(to) / usdRate(from))
// with usdRate(USD) = 1.
// ============================================================================

import { prisma } from "../config/database";

export const FX_BASE = "USD";
export const FX_TARGETS = ["TRY", "SAR", "AED", "EGP", "IQD", "EUR"] as const;

const ENDPOINT = "https://open.er-api.com/v6/latest/USD";

interface ErApiResponse {
  result?: string;
  rates?: Record<string, number>;
}

// UTC midnight Date for today (the unique key is date-truncated).
function utcDateOnly(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export async function hasAnyRates(): Promise<boolean> {
  const n = await prisma.fxRate.count();
  return n > 0;
}

// Fetch today's rates and upsert one row per target currency. Returns the count
// stored + the rate date. Throws only on a hard fetch failure (the cron catches).
export async function fetchAndStoreRates(): Promise<{ stored: number; rateDate: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let body: ErApiResponse;
  try {
    const resp = await fetch(ENDPOINT, { signal: controller.signal });
    if (!resp.ok) throw new Error(`open.er-api.com HTTP ${resp.status}`);
    body = (await resp.json()) as ErApiResponse;
  } finally {
    clearTimeout(timeout);
  }
  if (body.result !== "success" || !body.rates) {
    throw new Error(`open.er-api.com bad response: ${body.result ?? "unknown"}`);
  }

  const rateDate = utcDateOnly();
  let stored = 0;
  for (const quote of FX_TARGETS) {
    const rate = body.rates[quote];
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) continue;
    await prisma.fxRate.upsert({
      where: { base_quote_rateDate: { base: FX_BASE, quote, rateDate } },
      create: { base: FX_BASE, quote, rate, rateDate, source: "open.er-api.com" },
      update: { rate, fetchedAt: new Date(), source: "open.er-api.com" },
    });
    stored++;
  }
  return { stored, rateDate: rateDate.toISOString().slice(0, 10) };
}

// Latest stored USD→quote rate with rateDate ≤ atDate (default now). null if none.
export async function getLiveUsdRate(quote: string, atDate?: Date): Promise<number | null> {
  const q = quote.toUpperCase();
  if (q === FX_BASE) return 1;
  const row = await prisma.fxRate.findFirst({
    where: { base: FX_BASE, quote: q, rateDate: { lte: utcDateOnly(atDate) } },
    orderBy: { rateDate: "desc" },
    select: { rate: true },
  });
  return row ? Number(row.rate) : null;
}

// Bulk USD-rate map for a set of currencies (one query). Missing → omitted.
export async function getLiveUsdRateMap(
  currencies: string[],
  atDate?: Date
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  out.set(FX_BASE, 1);
  const wanted = Array.from(new Set(currencies.map((c) => c.toUpperCase()))).filter((c) => c !== FX_BASE);
  if (wanted.length === 0) return out;
  // Latest row per quote ≤ date. Small N (≤ a handful of currencies) → per-quote.
  for (const q of wanted) {
    const r = await getLiveUsdRate(q, atDate);
    if (r != null) out.set(q, r);
  }
  return out;
}

// The date of the most recent stored rate (for the "FX rates as of …" footnote).
export async function latestRateDate(): Promise<string | null> {
  const row = await prisma.fxRate.findFirst({ orderBy: { rateDate: "desc" }, select: { rateDate: true } });
  return row ? row.rateDate.toISOString().slice(0, 10) : null;
}
