// ============================================================================
// COHORT + FUNNEL ANALYTICS
// ----------------------------------------------------------------------------
// Two complementary views onto customer and deal lifecycle data:
//
//   COHORT RETENTION — group customers by the month they were acquired
//   (createdAt), then measure what percentage of each cohort is still
//   "active" N months later. A customer is active in month M if they had
//   ANY activity (created/updated deal, completed activity, or their own
//   updatedAt landed in that month).
//
//   PIPELINE FUNNEL — for deals created in a given window, count how many
//   reached each stage + measure avg time-to-stage. Reveals the leaks.
//
// Both work off existing tables (Customer, Deal, Activity) — no schema
// changes needed. The queries use raw SQL for the date bucketing because
// Prisma's groupBy doesn't support date truncation efficiently on Postgres.
// ============================================================================

import { prisma } from "../config/database";

// ──────────────────────────────────────────────────────────────────────
// COHORT RETENTION
// ──────────────────────────────────────────────────────────────────────

export interface CohortRow {
  cohortMonth: string;          // "2025-01" — month customers were acquired
  cohortSize: number;           // how many customers in this cohort
  retention: Array<{
    monthOffset: number;        // 0 = acquisition month, 1 = month after, …
    activeCount: number;        // customers still active that month
    retentionPct: number;       // activeCount / cohortSize × 100
  }>;
}

export interface CohortReport {
  baseCurrency: string;
  monthsBack: number;           // how many cohorts we're showing
  cohorts: CohortRow[];
  generatedAt: string;
}

/**
 * Generate monthly cohort retention data for the last `monthsBack` months.
 *
 * A customer is "active" in month M if there's evidence of engagement in
 * that month: a deal was created/updated, an activity was completed, or
 * the customer record itself was touched. This is stricter than "still
 * in the database" and gives a more honest retention picture.
 */
export async function getCohortReport(
  companyId: string,
  monthsBack: number = 12
): Promise<CohortReport> {
  // Clamp — we don't want someone asking for 10000 months.
  const n = Math.min(Math.max(monthsBack, 1), 24);

  // Figure out the cohort buckets: last N calendar months, oldest first.
  // We use UTC month boundaries to avoid timezone drift where a customer
  // created at 23:30 local time on the 31st lands in the wrong bucket.
  const now = new Date();
  const currentMonthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  );

  const cohortBuckets: Date[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(currentMonthStart);
    d.setUTCMonth(d.getUTCMonth() - i);
    cohortBuckets.push(d);
  }
  const oldestCohortStart = cohortBuckets[0];

  // Fetch every customer created on or after the oldest cohort start.
  // We keep customerId → cohortMonth mapping in memory — for a typical
  // merchant this is thousands of rows, very cheap.
  const customers = await prisma.customer.findMany({
    where: {
      companyId,
      createdAt: { gte: oldestCohortStart },
    },
    select: { id: true, createdAt: true },
  });

  // Assign each customer to their cohort
  const cohortOf = new Map<string, string>(); // customerId → "YYYY-MM"
  const cohortSize = new Map<string, number>(); // "YYYY-MM" → count
  for (const c of customers) {
    const key = monthKey(c.createdAt);
    cohortOf.set(c.id, key);
    cohortSize.set(key, (cohortSize.get(key) ?? 0) + 1);
  }

  // Gather all "activity evidence" rows in the full retention window.
  // We pull customer updatedAt, deal updatedAt, and activity completedAt
  // — any of these landing in a given month proves the customer is alive.
  const [customerUpdates, dealUpdates, activities] = await Promise.all([
    prisma.customer.findMany({
      where: {
        companyId,
        id: { in: Array.from(cohortOf.keys()) },
        updatedAt: { gte: oldestCohortStart },
      },
      select: { id: true, updatedAt: true },
    }),
    prisma.deal.findMany({
      where: {
        companyId,
        customerId: { in: Array.from(cohortOf.keys()) },
        updatedAt: { gte: oldestCohortStart },
      },
      select: { customerId: true, updatedAt: true },
    }),
    prisma.activity.findMany({
      where: {
        companyId,
        customerId: { in: Array.from(cohortOf.keys()) },
        completedAt: { gte: oldestCohortStart, not: null },
      },
      select: { customerId: true, completedAt: true },
    }),
  ]);

  // For each (customerId, monthKey), mark "was active"
  const activeByCustMonth = new Map<string, Set<string>>();
  const mark = (customerId: string | null, at: Date | null) => {
    if (!customerId || !at) return;
    const key = monthKey(at);
    let set = activeByCustMonth.get(customerId);
    if (!set) {
      set = new Set();
      activeByCustMonth.set(customerId, set);
    }
    set.add(key);
  };
  for (const c of customerUpdates) mark(c.id, c.updatedAt);
  for (const d of dealUpdates) mark(d.customerId, d.updatedAt);
  for (const a of activities) mark(a.customerId, a.completedAt);

  // Now build the cohort × month-offset grid
  const nowKey = monthKey(now);
  const cohorts: CohortRow[] = [];

  for (let i = 0; i < cohortBuckets.length; i++) {
    const cohortStart = cohortBuckets[i];
    const cohortMonth = monthKey(cohortStart);
    const size = cohortSize.get(cohortMonth) ?? 0;
    const retention: CohortRow["retention"] = [];

    // How many future months are observable from this cohort's POV?
    const monthsObservable = cohortBuckets.length - i;

    for (let offset = 0; offset < monthsObservable; offset++) {
      const targetMonth = addMonths(cohortStart, offset);
      const targetKey = monthKey(targetMonth);
      // Skip future months
      if (targetKey > nowKey) break;

      let activeCount = 0;
      for (const [customerId, cohortKey] of cohortOf.entries()) {
        if (cohortKey !== cohortMonth) continue;
        const active = activeByCustMonth.get(customerId);
        if (active && active.has(targetKey)) {
          activeCount++;
        }
      }

      retention.push({
        monthOffset: offset,
        activeCount,
        retentionPct:
          size > 0 ? Math.round((activeCount / size) * 1000) / 10 : 0,
      });
    }

    cohorts.push({
      cohortMonth,
      cohortSize: size,
      retention,
    });
  }

  return {
    baseCurrency: "USD", // kept for symmetry with other reports; unused here
    monthsBack: n,
    cohorts,
    generatedAt: new Date().toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────────────
// PIPELINE FUNNEL
// ──────────────────────────────────────────────────────────────────────

// Canonical stage order — merchants can customize their pipeline but
// these are the default labels from the seed data. The funnel respects
// whatever stages exist on actual deal rows and orders them by this
// list when known, alphabetically otherwise.
const STAGE_ORDER = [
  "lead",
  "qualified",
  "proposal",
  "negotiation",
  "won",
  "lost",
];

function stageRank(stage: string): number {
  const idx = STAGE_ORDER.indexOf(stage);
  return idx === -1 ? 99 : idx;
}

export interface FunnelStage {
  stage: string;
  totalDeals: number;         // deals that reached this stage (including
                              // those that moved past it)
  conversionToNext: number | null; // percentage of deals that moved to
                                    // the next stage (null for the final
                                    // stage in each path)
  avgDaysInStage: number;      // average time deals spent in this stage
                               // before moving on (or null if still here)
  openDeals: number;           // deals currently in this stage
  wonDeals: number;            // deals from this stage that went to won
  lostDeals: number;           // deals from this stage that went to lost
  totalValue: number;          // sum of value for deals currently here
  currency: string;
}

export interface FunnelReport {
  windowDays: number;
  stages: FunnelStage[];
  overallConversionRate: number; // first stage → won, percentage
  totalDeals: number;
  wonDeals: number;
  lostDeals: number;
  avgDealCycleDays: number | null; // time from creation to won, for won deals
  generatedAt: string;
}

/**
 * Build the pipeline funnel report. We consider deals CREATED within the
 * window (default 90 days) — expanding to "any deal" tends to drown out
 * recent leaks under historical noise.
 */
export async function getFunnelReport(
  companyId: string,
  windowDays: number = 90
): Promise<FunnelReport> {
  const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const deals = await prisma.deal.findMany({
    where: { companyId, createdAt: { gte: windowStart } },
    select: {
      id: true,
      stage: true,
      value: true,
      currency: true,
      createdAt: true,
      updatedAt: true,
      actualCloseDate: true,
    },
  });

  if (deals.length === 0) {
    return {
      windowDays,
      stages: [],
      overallConversionRate: 0,
      totalDeals: 0,
      wonDeals: 0,
      lostDeals: 0,
      avgDealCycleDays: null,
      generatedAt: new Date().toISOString(),
    };
  }

  // Collect all distinct stages that actually appear
  const seenStages = new Set<string>();
  for (const d of deals) seenStages.add(d.stage);
  // Always include the canonical terminal stages so the funnel reads
  // correctly even if the window had zero losses or wins.
  seenStages.add("won");
  seenStages.add("lost");

  const stageList = Array.from(seenStages).sort(
    (a, b) => stageRank(a) - stageRank(b)
  );

  // Primary currency: most frequent among open deals; fall back to USD
  const currencyCount = new Map<string, number>();
  for (const d of deals) {
    currencyCount.set(d.currency, (currencyCount.get(d.currency) ?? 0) + 1);
  }
  const primaryCurrency =
    [...currencyCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ||
    "USD";

  const stages: FunnelStage[] = stageList.map((stage) => ({
    stage,
    totalDeals: 0,
    conversionToNext: null,
    avgDaysInStage: 0,
    openDeals: 0,
    wonDeals: 0,
    lostDeals: 0,
    totalValue: 0,
    currency: primaryCurrency,
  }));

  // Build a rank → stage index map for fast lookup
  const stageIndex = new Map<string, number>();
  stages.forEach((s, i) => stageIndex.set(s.stage, i));

  // For each deal, figure out which stages it "passed through". Since we
  // don't have a full audit trail of stage transitions in this schema,
  // we approximate: a deal at stage X is assumed to have passed through
  // every earlier canonical stage. This is standard funnel practice when
  // transition history isn't captured.
  let wonCount = 0;
  let lostCount = 0;
  let totalCycleDaysWon = 0;

  const timeSumPerStage = new Array(stages.length).fill(0);
  const timeCountPerStage = new Array(stages.length).fill(0);

  for (const d of deals) {
    const currentStageIdx = stageIndex.get(d.stage);
    if (currentStageIdx === undefined) continue;

    // Mark every stage up to and including the current one as "reached"
    for (let i = 0; i <= currentStageIdx; i++) {
      stages[i].totalDeals++;
    }

    const isTerminal = d.stage === "won" || d.stage === "lost";
    if (!isTerminal) {
      stages[currentStageIdx].openDeals++;
      stages[currentStageIdx].totalValue += Number(d.value);
    }

    if (d.stage === "won") {
      wonCount++;
      // Credit the win back through all preceding stages
      for (let i = 0; i < currentStageIdx; i++) {
        if (stages[i].stage !== "won" && stages[i].stage !== "lost") {
          stages[i].wonDeals++;
        }
      }
      if (d.actualCloseDate) {
        const days =
          (new Date(d.actualCloseDate).getTime() -
            new Date(d.createdAt).getTime()) /
          (1000 * 60 * 60 * 24);
        totalCycleDaysWon += days;
      }
    } else if (d.stage === "lost") {
      lostCount++;
      for (let i = 0; i < currentStageIdx; i++) {
        if (stages[i].stage !== "won" && stages[i].stage !== "lost") {
          stages[i].lostDeals++;
        }
      }
    }

    // Time-in-current-stage estimation: for open deals, updatedAt − the
    // later of createdAt and (previous stage's last-seen-at, which we
    // don't have, so use createdAt). Approximate but shows trends.
    const daysInStage =
      (new Date(d.updatedAt).getTime() - new Date(d.createdAt).getTime()) /
      (1000 * 60 * 60 * 24);
    if (daysInStage >= 0) {
      timeSumPerStage[currentStageIdx] += daysInStage;
      timeCountPerStage[currentStageIdx]++;
    }
  }

  // Compute conversions: stage[i].conversionToNext = stage[i+1].totalDeals / stage[i].totalDeals
  for (let i = 0; i < stages.length; i++) {
    if (timeCountPerStage[i] > 0) {
      stages[i].avgDaysInStage =
        Math.round((timeSumPerStage[i] / timeCountPerStage[i]) * 10) / 10;
    }
    // Next non-terminal stage
    let nextIdx = -1;
    for (let j = i + 1; j < stages.length; j++) {
      if (stages[j].stage !== "won" && stages[j].stage !== "lost") {
        nextIdx = j;
        break;
      }
    }
    if (
      nextIdx !== -1 &&
      stages[i].totalDeals > 0 &&
      stages[i].stage !== "won" &&
      stages[i].stage !== "lost"
    ) {
      stages[i].conversionToNext =
        Math.round((stages[nextIdx].totalDeals / stages[i].totalDeals) * 1000) /
        10;
    }
    stages[i].totalValue = Math.round(stages[i].totalValue * 100) / 100;
  }

  const firstStage = stages.find(
    (s) => s.stage !== "won" && s.stage !== "lost"
  );
  const overallConversionRate = firstStage
    ? Math.round((wonCount / Math.max(firstStage.totalDeals, 1)) * 1000) / 10
    : 0;

  return {
    windowDays,
    stages,
    overallConversionRate,
    totalDeals: deals.length,
    wonDeals: wonCount,
    lostDeals: lostCount,
    avgDealCycleDays:
      wonCount > 0 ? Math.round((totalCycleDaysWon / wonCount) * 10) / 10 : null,
    generatedAt: new Date().toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────────────────

function monthKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function addMonths(d: Date, months: number): Date {
  const r = new Date(d);
  r.setUTCMonth(r.getUTCMonth() + months);
  return r;
}
