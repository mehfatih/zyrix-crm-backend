// ============================================================================
// CAC CORE (Sprint 1 of 3) — Customer Acquisition Cost (raw SQL, tenant-scoped).
// ----------------------------------------------------------------------------
// Monthly CAC = acquisition spend ÷ newly-acquired customers, in base currency
// (TRY). Two views per month:
//   • BLENDED  — total spend ÷ total new customers (always honest).
//   • PER-CHANNEL — spend-by-platform ÷ new-customers-by-platform, with an
//     attribution COVERAGE % so thin coverage is visible (never faked).
//
// "Newly-acquired customer" = a customer whose FIRST WON deal closed in that
// month — real paid acquisition, not a registered contact. Derived (no stored
// field) via DISTINCT ON (customerId) ORDER BY actualCloseDate. Shopify paid
// orders flow through `deals` (stage='won'), so ecommerce is included.
//
// Acquisition spend (Sprint 1) = the existing Sprint-24 ad_spend_entries, summed
// in base TRY from the frozen `amountBase`. NULL/unconverted rows are surfaced
// (spendUnconverted / spendComplete), never guessed — identical to campaign &
// deal economics. Per-platform attribution reuses Sprint-25 deals.attributionSource
// → platformForSource(). Customers with no source go to a visible "unattributed"
// share (counted in blended + coverage denominator, not in any platform bucket).
//
// Gated by the `cac` entitlement (ALL_ON — a gift to every plan). Sprint 2 folds
// in NON-AD acquisition costs (the acquisition_costs ledger, guarded) so blended
// CAC reflects TRUE total acquisition cost — ad spend is summed UNCHANGED; the
// cost SUM is purely additive (empty ledger ⇒ identical numbers to Sprint 1).
// Later sprints add forecasting + recommendations.
// ============================================================================

import { prisma } from "../config/database";
import { getBaseCurrency } from "./deal-economics.service";
import { platformForSource } from "./attribution";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
function toNum(v: unknown): number {
  return v == null ? 0 : Number(v);
}

/** Guard: the Sprint-2 acquisition_costs table is applied out-of-band on Railway.
 *  If it isn't present yet (code can deploy before the SQL is applied), CAC
 *  degrades to ad-spend-only rather than crashing. */
async function acquisitionCostsTableExists(): Promise<boolean> {
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT to_regclass('public.acquisition_costs') AS t`
    )) as Array<{ t: string | null }>;
    return rows[0]?.t != null;
  } catch {
    return false;
  }
}

export interface CacPlatformMonth {
  platform: string;
  spendBase: number;
  newCustomers: number;
  cac: number | null; // null when no attributed customers for this platform that month
}

export interface CacMonth {
  month: string; // 'YYYY-MM'
  newCustomers: number;
  attributedCustomers: number; // new customers carrying any attributionSource
  coveragePct: number | null; // attributed ÷ total × 100 (null when no new customers)
  spendBase: number; // base TRY
  spendUnconverted: number; // count of spend rows with NULL amountBase (no FX rate)
  spendComplete: boolean; // spendUnconverted === 0
  cac: number | null; // BLENDED: spendBase ÷ newCustomers (null when no new customers)
  platforms: CacPlatformMonth[];
}

export interface CacSummary {
  baseCurrency: string;
  rangeMonths: number;
  fromMonth: string;
  toMonth: string;
  // Window totals (the dashboard widget shows the blended figure).
  totalNewCustomers: number;
  totalSpendBase: number;
  totalSpendUnconverted: number;
  blendedCac: number | null;
  overallCoveragePct: number | null;
  months: CacMonth[]; // chronological, includes empty months (newCustomers 0)
}

/** Build the ordered list of YYYY-MM keys for the trailing `months` window and
 *  the UTC start-of-window date used to bound the SQL. */
function monthRange(months: number): {
  fromMonth: string;
  toMonth: string;
  keys: string[];
  fromDate: Date;
} {
  const now = new Date();
  const startTotal = now.getUTCFullYear() * 12 + now.getUTCMonth() - (months - 1);
  const keys: string[] = [];
  for (let i = 0; i < months; i++) {
    const t = startTotal + i;
    keys.push(`${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`);
  }
  const fromDate = new Date(Date.UTC(Math.floor(startTotal / 12), startTotal % 12, 1, 0, 0, 0));
  return { fromMonth: keys[0], toMonth: keys[keys.length - 1], keys, fromDate };
}

type MonthAcc = {
  newCustomers: number;
  attributed: number;
  custByPlatform: Map<string, number>;
  spendBase: number;
  spendUnconverted: number;
  spendByPlatform: Map<string, number>;
};

export async function computeMonthlyCac(companyId: string, months = 12): Promise<CacSummary> {
  const m = Math.max(1, Math.min(36, Math.floor(months) || 12));
  const baseCurrency = await getBaseCurrency(companyId);
  const { fromMonth, toMonth, keys, fromDate } = monthRange(m);
  const fromIso = fromDate.toISOString();

  // ── New (paid-acquired) customers per month per source ──
  // Inner DISTINCT ON picks each customer's FIRST won deal across all time; the
  // outer WHERE keeps only those whose first win lands in the window (so repeat
  // buyers and pre-window customers are excluded). attributionSource is a raw
  // Sprint-25 column (not on the Prisma model) — read via raw SQL.
  const custRows = (await prisma.$queryRawUnsafe(
    `SELECT to_char(date_trunc('month', first_won_at), 'YYYY-MM') AS month,
            "attributionSource" AS source,
            COUNT(*)::int AS c
       FROM (
         SELECT DISTINCT ON (d."customerId")
                d."customerId",
                d."actualCloseDate" AS first_won_at,
                d."attributionSource" AS "attributionSource"
           FROM deals d
          WHERE d."companyId" = $1 AND d."stage" = 'won' AND d."actualCloseDate" IS NOT NULL
          ORDER BY d."customerId", d."actualCloseDate" ASC, d."id" ASC
       ) firsts
      WHERE first_won_at >= $2::timestamptz
      GROUP BY 1, 2`,
    companyId,
    fromIso
  )) as Array<{ month: string; source: string | null; c: number }>;

  // ── Acquisition spend (base TRY) per month per platform ──
  const spendRows = (await prisma.$queryRawUnsafe(
    `SELECT to_char(date_trunc('month', "spendDate"), 'YYYY-MM') AS month,
            "platform" AS platform,
            COALESCE(SUM("amountBase"),0)::text AS "spendBase",
            COUNT(*) FILTER (WHERE "amountBase" IS NULL)::int AS "spendUnconverted"
       FROM ad_spend_entries
      WHERE "companyId" = $1 AND "spendDate" >= $2::date
      GROUP BY 1, 2`,
    companyId,
    fromIso
  )) as Array<{ month: string; platform: string | null; spendBase: string; spendUnconverted: number }>;

  // ── Non-ad acquisition costs (base TRY) per month per channel ── (Sprint 2)
  // Additive: folded into the SAME spend totals so blended CAC reflects TRUE total
  // acquisition cost. GUARDED — degrades to ad-only if the table isn't applied yet
  // (no crash). channel-tagged costs roll into that platform's bucket; untagged
  // costs go to a distinct "non_ad" bucket. amountBase NULL rows counted as
  // unconverted (honest), never guessed — identical to ad spend.
  let costRows: Array<{ month: string; platform: string | null; spendBase: string; spendUnconverted: number }> = [];
  if (await acquisitionCostsTableExists()) {
    try {
      costRows = (await prisma.$queryRawUnsafe(
        `SELECT to_char(date_trunc('month', "costDate"), 'YYYY-MM') AS month,
                "channel" AS platform,
                COALESCE(SUM("amountBase"),0)::text AS "spendBase",
                COUNT(*) FILTER (WHERE "amountBase" IS NULL)::int AS "spendUnconverted"
           FROM acquisition_costs
          WHERE "companyId" = $1 AND "costDate" >= $2::date
          GROUP BY 1, 2`,
        companyId,
        fromIso
      )) as Array<{ month: string; platform: string | null; spendBase: string; spendUnconverted: number }>;
    } catch {
      costRows = []; // any runtime hiccup → degrade to ad-only, never crash CAC
    }
  }

  const acc = new Map<string, MonthAcc>();
  const ensure = (mk: string): MonthAcc => {
    let a = acc.get(mk);
    if (!a) {
      a = {
        newCustomers: 0,
        attributed: 0,
        custByPlatform: new Map(),
        spendBase: 0,
        spendUnconverted: 0,
        spendByPlatform: new Map(),
      };
      acc.set(mk, a);
    }
    return a;
  };

  for (const r of custRows) {
    const a = ensure(r.month);
    a.newCustomers += r.c;
    if (r.source != null) a.attributed += r.c;
    const plat = r.source ? platformForSource(r.source) : null; // null = no platform rollup
    if (plat) a.custByPlatform.set(plat, (a.custByPlatform.get(plat) ?? 0) + r.c);
  }
  for (const r of spendRows) {
    const a = ensure(r.month);
    const sb = round2(toNum(r.spendBase));
    a.spendBase = round2(a.spendBase + sb);
    a.spendUnconverted += Number(r.spendUnconverted ?? 0);
    const plat = r.platform || "other";
    a.spendByPlatform.set(plat, round2((a.spendByPlatform.get(plat) ?? 0) + sb));
  }
  // Non-ad costs fold into the SAME accumulator (Sprint 2). Untagged → "non_ad".
  for (const r of costRows) {
    const a = ensure(r.month);
    const sb = round2(toNum(r.spendBase));
    a.spendBase = round2(a.spendBase + sb);
    a.spendUnconverted += Number(r.spendUnconverted ?? 0);
    const plat = r.platform || "non_ad";
    a.spendByPlatform.set(plat, round2((a.spendByPlatform.get(plat) ?? 0) + sb));
  }

  const monthsOut: CacMonth[] = keys.map((mk) => {
    const a = acc.get(mk);
    const newCustomers = a?.newCustomers ?? 0;
    const attributed = a?.attributed ?? 0;
    const spendBase = a?.spendBase ?? 0;
    const spendUnconverted = a?.spendUnconverted ?? 0;

    const platSet = new Set<string>();
    a?.spendByPlatform.forEach((_v, k) => platSet.add(k));
    a?.custByPlatform.forEach((_v, k) => platSet.add(k));
    const platforms: CacPlatformMonth[] = [...platSet].sort().map((p) => {
      const psb = a?.spendByPlatform.get(p) ?? 0;
      const pn = a?.custByPlatform.get(p) ?? 0;
      return { platform: p, spendBase: psb, newCustomers: pn, cac: pn > 0 ? round2(psb / pn) : null };
    });

    return {
      month: mk,
      newCustomers,
      attributedCustomers: attributed,
      coveragePct: newCustomers > 0 ? round2((attributed / newCustomers) * 100) : null,
      spendBase,
      spendUnconverted,
      spendComplete: spendUnconverted === 0,
      cac: newCustomers > 0 ? round2(spendBase / newCustomers) : null,
      platforms,
    };
  });

  const totalNewCustomers = monthsOut.reduce((s, x) => s + x.newCustomers, 0);
  const totalAttributed = monthsOut.reduce((s, x) => s + x.attributedCustomers, 0);
  const totalSpendBase = round2(monthsOut.reduce((s, x) => s + x.spendBase, 0));
  const totalSpendUnconverted = monthsOut.reduce((s, x) => s + x.spendUnconverted, 0);

  return {
    baseCurrency,
    rangeMonths: m,
    fromMonth,
    toMonth,
    totalNewCustomers,
    totalSpendBase,
    totalSpendUnconverted,
    blendedCac: totalNewCustomers > 0 ? round2(totalSpendBase / totalNewCustomers) : null,
    overallCoveragePct: totalNewCustomers > 0 ? round2((totalAttributed / totalNewCustomers) * 100) : null,
    months: monthsOut,
  };
}
