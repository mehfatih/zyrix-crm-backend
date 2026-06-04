// ============================================================================
// REVENUE BRAIN SERVICE
// ----------------------------------------------------------------------------
// Deterministic monthly revenue forecast computed from deals + quotas. No AI:
// a forecast must be reproducible. Driver/reason/action labels are templated
// (en/ar/tr). Scoped by companyId; the route restricts to manager+.
// ============================================================================

import { prisma } from "../config/database";

export type Locale = "en" | "ar" | "tr";
const tr = (l: Locale, en: string, ar: string, trk: string) =>
  l === "ar" ? ar : l === "tr" ? trk : en;

export interface RevenueScenario {
  id: "conservative" | "expected" | "optimistic";
  label: string;
  amount: number;
  probability: number;
  drivers: string[];
}

export interface RevenueLeakage {
  category: string;
  amount: number;
  reason: string;
}

export interface RevenueBrainData {
  monthlyTarget: number;
  monthlyActual: number;
  monthlyProgress: number;
  targetSource: "quota" | "derived";
  scenarios: RevenueScenario[];
  leakage: RevenueLeakage[];
  recommendedActions: Array<{ label: string; impact: number; confidence: number }>;
  confidence: number;
}

function monthBounds(now: Date) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}
function periodKey(d: Date) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function getRevenueBrain(
  companyId: string,
  locale: Locale = "en"
): Promise<RevenueBrainData> {
  const now = new Date();
  const { start, end } = monthBounds(now);

  // 1. Actual: won deals closed this month.
  const wonAgg = await prisma.deal.aggregate({
    where: { companyId, stage: "won", actualCloseDate: { gte: start, lt: end } },
    _sum: { value: true },
    _count: true,
  });
  const monthlyActual = Number(wonAgg._sum.value ?? 0);
  const wonCount = wonAgg._count ?? 0;

  // 2. Target: sum quotas for this month; fallback = trailing-3-month avg won.
  const quotas = await prisma.quota.findMany({
    where: { companyId, period: periodKey(now) },
    select: { target: true },
  });
  let monthlyTarget = quotas.reduce((s, q) => s + Number(q.target), 0);
  let targetSource: "quota" | "derived" = "quota";
  if (monthlyTarget <= 0) {
    const t3Start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1));
    const prevAgg = await prisma.deal.aggregate({
      where: { companyId, stage: "won", actualCloseDate: { gte: t3Start, lt: start } },
      _sum: { value: true },
    });
    monthlyTarget = Math.round(Number(prevAgg._sum.value ?? 0) / 3);
    targetSource = "derived";
  }
  const monthlyProgress =
    monthlyTarget > 0 ? Math.round((monthlyActual / monthlyTarget) * 100) : 0;

  // 3. Open pipeline expected to close this month → scenarios.
  const openInMonth = await prisma.deal.findMany({
    where: {
      companyId,
      stage: { notIn: ["won", "lost"] },
      expectedCloseDate: { gte: start, lt: end },
    },
    select: { value: true, probability: true },
  });
  let weighted = 0;
  let openTotal = 0;
  for (const d of openInMonth) {
    const v = Number(d.value);
    openTotal += v;
    weighted += v * (Number(d.probability ?? 0) / 100);
  }

  const scenarios: RevenueScenario[] = [
    {
      id: "conservative",
      label: tr(locale, "Conservative", "متحفّظ", "İhtiyatlı"),
      amount: Math.round(monthlyActual),
      probability: 90,
      drivers: [tr(locale, "Confirmed (won) revenue only", "الإيراد المؤكّد فقط", "Yalnızca kazanılan gelir")],
    },
    {
      id: "expected",
      label: tr(locale, "Expected", "متوقّع", "Beklenen"),
      amount: Math.round(monthlyActual + weighted),
      probability: 60,
      drivers: [tr(locale, "Open pipeline weighted by win probability", "المسار المفتوح موزون باحتمال الفوز", "Kazanma olasılığına göre ağırlıklı hat")],
    },
    {
      id: "optimistic",
      label: tr(locale, "Optimistic", "متفائل", "İyimser"),
      amount: Math.round(monthlyActual + openTotal),
      probability: 25,
      drivers: [tr(locale, "All in-month open deals close", "إغلاق كل الصفقات المفتوحة هذا الشهر", "Bu ayki tüm açık anlaşmalar kapanır")],
    },
  ];

  // 4. Leakage: stalled open deals (untouched >7d) + lost this month.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const stalledAgg = await prisma.deal.aggregate({
    where: { companyId, stage: { notIn: ["won", "lost"] }, updatedAt: { lt: sevenDaysAgo } },
    _sum: { value: true },
    _count: true,
  });
  const stalledValue = Number(stalledAgg._sum.value ?? 0);
  const stalledCount = stalledAgg._count ?? 0;

  const lostAgg = await prisma.deal.aggregate({
    where: { companyId, stage: "lost", actualCloseDate: { gte: start, lt: end } },
    _sum: { value: true },
    _count: true,
  });
  const lostValue = Number(lostAgg._sum.value ?? 0);
  const lostCount = lostAgg._count ?? 0;

  const leakage: RevenueLeakage[] = [];
  if (stalledValue > 0) {
    leakage.push({
      category: tr(locale, "Stalled deals", "صفقات متوقّفة", "Durmuş anlaşmalar"),
      amount: Math.round(stalledValue),
      reason: tr(
        locale,
        `${stalledCount} open deals untouched >7 days`,
        `${stalledCount} صفقة مفتوحة دون تحديث منذ أكثر من 7 أيام`,
        `${stalledCount} açık anlaşma 7 günden fazla güncellenmedi`
      ),
    });
  }
  if (lostValue > 0) {
    leakage.push({
      category: tr(locale, "Lost this month", "مفقودة هذا الشهر", "Bu ay kaybedilen"),
      amount: Math.round(lostValue),
      reason: tr(
        locale,
        `${lostCount} deals marked lost`,
        `${lostCount} صفقة محدّدة كمفقودة`,
        `${lostCount} anlaşma kaybedildi olarak işaretlendi`
      ),
    });
  }

  // 5. Recommended actions (templated from the computed leakage / gap).
  const recommendedActions: Array<{ label: string; impact: number; confidence: number }> = [];
  if (stalledCount > 0) {
    recommendedActions.push({
      label: tr(
        locale,
        `Follow up ${stalledCount} stalled deals`,
        `تابِع ${stalledCount} صفقة متوقّفة`,
        `${stalledCount} durmuş anlaşmayı takip et`
      ),
      impact: Math.round(stalledValue * 0.3),
      confidence: 75,
    });
  }
  if (weighted > 0) {
    recommendedActions.push({
      label: tr(
        locale,
        "Prioritize high-probability open deals",
        "أعطِ الأولوية للصفقات المفتوحة عالية الاحتمال",
        "Yüksek olasılıklı açık anlaşmalara öncelik ver"
      ),
      impact: Math.round(weighted * 0.5),
      confidence: 68,
    });
  }
  const gap = monthlyTarget - monthlyActual;
  if (monthlyTarget > 0 && gap > 0) {
    recommendedActions.push({
      label: tr(
        locale,
        `Close the $${Math.round(gap / 1000)}k gap to target`,
        `أغلِق فجوة $${Math.round(gap / 1000)}k نحو الهدف`,
        `Hedefe $${Math.round(gap / 1000)}k farkı kapat`
      ),
      impact: Math.round(gap),
      confidence: 60,
    });
  }

  // 6. Confidence: more data (closed history + live pipeline) → higher. 40–90.
  const dataPoints = wonCount + openInMonth.length;
  const confidence = Math.max(40, Math.min(90, 45 + dataPoints * 3));

  return {
    monthlyTarget,
    monthlyActual,
    monthlyProgress,
    targetSource,
    scenarios,
    leakage,
    recommendedActions,
    confidence,
  };
}
