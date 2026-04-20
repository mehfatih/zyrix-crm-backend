import { prisma } from "../config/database";

// ============================================================================
// CASH FLOW FORECAST SERVICE
// Pure analytics on Deal table — no schema changes
// ============================================================================

export type Horizon = 30 | 60 | 90;

export interface ForecastBucket {
  label: string;
  startDate: string;
  endDate: string;
  weightedValue: number;
  dealCount: number;
  totalValue: number;
}

export interface ForecastSummary {
  horizon: Horizon;
  totalWeightedValue: number;
  totalPotentialValue: number;
  dealCount: number;
  avgProbability: number;
  currency: string;
  buckets: ForecastBucket[];
  topDeals: TopDeal[];
  byStage: { stage: string; count: number; weightedValue: number }[];
}

export interface TopDeal {
  id: string;
  title: string;
  value: number;
  currency: string;
  probability: number;
  weightedValue: number;
  stage: string;
  expectedCloseDate: string | null;
  customer: {
    id: string;
    fullName: string;
    companyName: string | null;
  };
}

// ─────────────────────────────────────────────────────────────────────────
// FORECAST
// ─────────────────────────────────────────────────────────────────────────
export async function getForecast(
  companyId: string,
  horizon: Horizon = 30,
  currency = "TRY"
): Promise<ForecastSummary> {
  const now = new Date();
  const end = new Date(now.getTime() + horizon * 24 * 60 * 60 * 1000);

  const deals = await prisma.deal.findMany({
    where: {
      companyId,
      expectedCloseDate: { gte: now, lte: end },
      stage: { notIn: ["won", "lost"] },
    },
    include: {
      customer: {
        select: { id: true, fullName: true, companyName: true },
      },
    },
    orderBy: { expectedCloseDate: "asc" },
  });

  // Compute buckets — weekly for 30/60, bi-weekly for 90
  const bucketSizeDays = horizon === 30 ? 7 : horizon === 60 ? 10 : 14;
  const bucketCount = Math.ceil(horizon / bucketSizeDays);

  const buckets: ForecastBucket[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const bStart = new Date(
      now.getTime() + i * bucketSizeDays * 24 * 60 * 60 * 1000
    );
    const bEnd = new Date(
      now.getTime() + (i + 1) * bucketSizeDays * 24 * 60 * 60 * 1000
    );

    let weightedValue = 0;
    let totalValue = 0;
    let dealCount = 0;

    for (const d of deals) {
      if (!d.expectedCloseDate) continue;
      const dClose = new Date(d.expectedCloseDate);
      if (dClose >= bStart && dClose < bEnd) {
        const value = Number(d.value);
        const weighted = value * (d.probability / 100);
        weightedValue += weighted;
        totalValue += value;
        dealCount++;
      }
    }

    buckets.push({
      label: formatBucketLabel(bStart, bEnd),
      startDate: bStart.toISOString(),
      endDate: bEnd.toISOString(),
      weightedValue: Math.round(weightedValue * 100) / 100,
      dealCount,
      totalValue: Math.round(totalValue * 100) / 100,
    });
  }

  // Aggregates
  const totalWeightedValue = deals.reduce(
    (sum, d) => sum + Number(d.value) * (d.probability / 100),
    0
  );
  const totalPotentialValue = deals.reduce(
    (sum, d) => sum + Number(d.value),
    0
  );
  const avgProbability =
    deals.length > 0
      ? deals.reduce((sum, d) => sum + d.probability, 0) / deals.length
      : 0;

  // Top deals by weighted value
  const topDeals: TopDeal[] = deals
    .map((d) => ({
      id: d.id,
      title: d.title,
      value: Number(d.value),
      currency: d.currency,
      probability: d.probability,
      weightedValue: Number(d.value) * (d.probability / 100),
      stage: d.stage,
      expectedCloseDate: d.expectedCloseDate
        ? d.expectedCloseDate.toISOString()
        : null,
      customer: d.customer,
    }))
    .sort((a, b) => b.weightedValue - a.weightedValue)
    .slice(0, 10);

  // By stage
  const stageMap = new Map<string, { count: number; weightedValue: number }>();
  for (const d of deals) {
    const curr = stageMap.get(d.stage) ?? { count: 0, weightedValue: 0 };
    curr.count++;
    curr.weightedValue += Number(d.value) * (d.probability / 100);
    stageMap.set(d.stage, curr);
  }
  const byStage = Array.from(stageMap.entries())
    .map(([stage, data]) => ({
      stage,
      count: data.count,
      weightedValue: Math.round(data.weightedValue * 100) / 100,
    }))
    .sort((a, b) => b.weightedValue - a.weightedValue);

  return {
    horizon,
    totalWeightedValue: Math.round(totalWeightedValue * 100) / 100,
    totalPotentialValue: Math.round(totalPotentialValue * 100) / 100,
    dealCount: deals.length,
    avgProbability: Math.round(avgProbability * 10) / 10,
    currency,
    buckets,
    topDeals,
    byStage,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// COMPARE HISTORICAL (last 30 days of won deals vs forecast)
// ─────────────────────────────────────────────────────────────────────────
export async function getHistoricalContext(companyId: string) {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [wonLast30, lostLast30, wonAvgValue] = await Promise.all([
    prisma.deal.aggregate({
      where: {
        companyId,
        stage: "won",
        actualCloseDate: { gte: thirtyDaysAgo },
      },
      _sum: { value: true },
      _count: { id: true },
    }),
    prisma.deal.count({
      where: {
        companyId,
        stage: "lost",
        actualCloseDate: { gte: thirtyDaysAgo },
      },
    }),
    prisma.deal.aggregate({
      where: { companyId, stage: "won" },
      _avg: { value: true },
    }),
  ]);

  const won = wonLast30._count.id ?? 0;
  const total = won + lostLast30;
  const winRate = total > 0 ? (won / total) * 100 : 0;

  return {
    wonLast30dCount: won,
    wonLast30dValue: Number(wonLast30._sum.value ?? 0),
    lostLast30dCount: lostLast30,
    winRatePercent: Math.round(winRate * 10) / 10,
    historicalAvgDealSize: Math.round(
      Number(wonAvgValue._avg.value ?? 0) * 100
    ) / 100,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────
function formatBucketLabel(start: Date, end: Date): string {
  const s = start.toISOString().slice(5, 10);
  const e = new Date(end.getTime() - 1).toISOString().slice(5, 10);
  return `${s} → ${e}`;
}
