// ============================================================================
// INSIGHTS SERVICE — Executive Summary + Priority Actions
// ----------------------------------------------------------------------------
// Deterministic, compute-based decision support from real CRM data (deals,
// customers, quotas). No AI — figures must be reproducible. Labels templated
// en/ar/tr. Company-scoped; the route restricts to manager+.
// ============================================================================

import { prisma } from "../config/database";
import { getRevenueBrain } from "./revenue-brain.service";

export type Locale = "en" | "ar" | "tr";
const tr = (l: Locale, en: string, ar: string, trk: string) =>
  l === "ar" ? ar : l === "tr" ? trk : en;

export interface AIPriorityAction {
  id: string;
  rank: number;
  type: "risk" | "opportunity" | "followup" | "revenue" | "retention";
  title: string;
  description: string;
  reason: string;
  confidence: number;
  signals: string[];
  recommendedAction: string;
  cta: { label: string; action: string; targetUrl?: string };
  entityId?: string;
  entityType?: string;
}

export interface AIExecutiveSummary {
  greeting: string;
  oneLineNarrative: string;
  topPriorities: number;
  revenueAtRisk: number;
  opportunities: number;
  confidence: number;
  cta: Array<{ label: string; action: string }>;
}

// ── shared computations ────────────────────────────────────────────────

interface AtRiskCustomer {
  id: string;
  fullName: string;
  daysSinceContact: number;
  openValue: number;
}

async function atRiskCustomers(companyId: string): Promise<AtRiskCustomer[]> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT c.id, c."fullName",
            COALESCE(EXTRACT(DAY FROM NOW() - c."lastContactAt")::int, 999) AS days,
            COALESCE(SUM(d.value), 0)::float AS "openValue"
       FROM customers c
       JOIN deals d ON d."customerId" = c.id
      WHERE c."companyId" = $1
        AND c.status <> 'lost'
        AND d.stage NOT IN ('won', 'lost')
        AND (c."lastContactAt" IS NULL OR c."lastContactAt" < NOW() - interval '30 days')
      GROUP BY c.id, c."fullName", c."lastContactAt"
      ORDER BY "openValue" DESC
      LIMIT 3`,
    companyId
  )) as { id: string; fullName: string; days: number; openValue: number }[];
  return rows.map((r) => ({
    id: r.id,
    fullName: r.fullName,
    daysSinceContact: Number(r.days),
    openValue: Number(r.openValue),
  }));
}

async function stalledDeals(companyId: string): Promise<{ count: number; value: number }> {
  const agg = await prisma.deal.aggregate({
    where: { companyId, stage: { notIn: ["won", "lost"] }, updatedAt: { lt: new Date(Date.now() - 7 * 86400000) } },
    _sum: { value: true },
    _count: true,
  });
  return { count: agg._count ?? 0, value: Number(agg._sum.value ?? 0) };
}

interface HotDeal {
  id: string;
  title: string;
  value: number;
  probability: number;
  customerName: string | null;
}

async function hotDeals(companyId: string): Promise<HotDeal[]> {
  const rows = await prisma.deal.findMany({
    where: { companyId, stage: { notIn: ["won", "lost"] }, probability: { gte: 70 } },
    select: { id: true, title: true, value: true, probability: true, customer: { select: { fullName: true } } },
    orderBy: { value: "desc" },
    take: 2,
  });
  return rows.map((d) => ({
    id: d.id,
    title: d.title,
    value: Number(d.value),
    probability: d.probability ?? 0,
    customerName: d.customer?.fullName ?? null,
  }));
}

const fmtK = (n: number) => `$${Math.round(n / 1000)}k`;

// ── priority actions ────────────────────────────────────────────────────

export async function getPriorityActions(
  companyId: string,
  locale: Locale = "en"
): Promise<AIPriorityAction[]> {
  const [atRisk, stalled, hot, brain] = await Promise.all([
    atRiskCustomers(companyId),
    stalledDeals(companyId),
    hotDeals(companyId),
    getRevenueBrain(companyId, locale),
  ]);

  // Each candidate carries a numeric score for ranking (impact-ish × confidence).
  const candidates: Array<AIPriorityAction & { _score: number }> = [];

  atRisk.forEach((c, i) => {
    candidates.push({
      id: `risk-${c.id}`,
      rank: 0,
      type: "risk",
      title: tr(locale, `${c.fullName} showing churn signals`, `${c.fullName} تُظهر إشارات تسرّب`, `${c.fullName} kayıp sinyalleri gösteriyor`),
      description: tr(
        locale,
        `${fmtK(c.openValue)} open, no contact in ${c.daysSinceContact}d.`,
        `${fmtK(c.openValue)} مفتوحة، دون تواصل منذ ${c.daysSinceContact} يومًا.`,
        `${fmtK(c.openValue)} açık, ${c.daysSinceContact} gündür iletişim yok.`
      ),
      reason: tr(
        locale,
        `High-value account with no recent contact.`,
        `حساب عالي القيمة دون تواصل حديث.`,
        `Yakın zamanda iletişim olmayan yüksek değerli hesap.`
      ),
      confidence: 80,
      signals: [
        tr(locale, `${c.daysSinceContact}d since contact`, `${c.daysSinceContact} يوم منذ التواصل`, `${c.daysSinceContact}g iletişimsiz`),
        tr(locale, `${fmtK(c.openValue)} open value`, `${fmtK(c.openValue)} قيمة مفتوحة`, `${fmtK(c.openValue)} açık değer`),
      ],
      recommendedAction: tr(locale, "Schedule a personal check-in within 48 hours", "جدوِل محادثة شخصية خلال 48 ساعة", "48 saat içinde kişisel görüşme planla"),
      cta: { label: tr(locale, "Open customer", "افتح العميل", "Müşteriyi aç"), action: "open", targetUrl: `/customers/${c.id}` },
      entityId: c.id,
      entityType: "customer",
      _score: c.openValue * 0.8 + (1000 - i),
    });
  });

  if (stalled.count > 0) {
    candidates.push({
      id: "followup-stalled",
      rank: 0,
      type: "followup",
      title: tr(locale, `${stalled.count} deals silent past baseline`, `${stalled.count} صفقة صامتة بعد الحد الأساسي`, `${stalled.count} anlaşma temel çizginin ötesinde sessiz`),
      description: tr(locale, `Combined ${fmtK(stalled.value)} awaiting follow-up.`, `قيمة مجمّعة ${fmtK(stalled.value)} تنتظر المتابعة.`, `Takip bekleyen toplam ${fmtK(stalled.value)}.`),
      reason: tr(locale, "Open deals untouched for more than 7 days.", "صفقات مفتوحة دون تحديث لأكثر من 7 أيام.", "7 günden fazla güncellenmemiş açık anlaşmalar."),
      confidence: 75,
      signals: [tr(locale, `${stalled.count} deals >7d idle`, `${stalled.count} صفقة خاملة >7 أيام`, `${stalled.count} anlaşma >7g hareketsiz`)],
      recommendedAction: tr(locale, "Run a follow-up batch on the stalled deals", "شغّل دفعة متابعة على الصفقات المتوقفة", "Durmuş anlaşmalara toplu takip uygula"),
      cta: { label: tr(locale, "Review deals", "راجع الصفقات", "Anlaşmaları incele"), action: "open", targetUrl: `/deals` },
      _score: stalled.value * 0.6 + 500,
    });
  }

  hot.forEach((d, i) => {
    candidates.push({
      id: `opp-${d.id}`,
      rank: 0,
      type: "opportunity",
      title: tr(locale, `${d.title} likely to close`, `${d.title} مرشّحة للإغلاق`, `${d.title} kapanmaya yakın`),
      description: tr(
        locale,
        `${fmtK(d.value)} at ${d.probability}% probability${d.customerName ? ` · ${d.customerName}` : ""}.`,
        `${fmtK(d.value)} باحتمال ${d.probability}%${d.customerName ? ` · ${d.customerName}` : ""}.`,
        `%${d.probability} olasılıkla ${fmtK(d.value)}${d.customerName ? ` · ${d.customerName}` : ""}.`
      ),
      reason: tr(locale, "High win probability — prioritize to close.", "احتمال فوز مرتفع — أعطِها الأولوية للإغلاق.", "Yüksek kazanma olasılığı — kapatmaya öncelik ver."),
      confidence: Math.min(95, 60 + d.probability / 3),
      signals: [tr(locale, `${d.probability}% win probability`, `${d.probability}% احتمال فوز`, `%${d.probability} kazanma olasılığı`), `${fmtK(d.value)}`],
      recommendedAction: tr(locale, "Prioritize this deal to close this period", "أعطِ الأولوية لإغلاق هذه الصفقة هذه الفترة", "Bu dönem kapatmak için bu anlaşmaya öncelik ver"),
      cta: { label: tr(locale, "Open deal", "افتح الصفقة", "Anlaşmayı aç"), action: "open", targetUrl: `/deals/${d.id}` },
      entityId: d.id,
      entityType: "deal",
      _score: d.value * (d.probability / 100) + (100 - i),
    });
  });

  const gap = brain.monthlyTarget - brain.monthlyActual;
  if (brain.monthlyTarget > 0 && gap > 0) {
    candidates.push({
      id: "revenue-gap",
      rank: 0,
      type: "revenue",
      title: tr(locale, `Monthly target ${brain.monthlyProgress}% complete`, `الهدف الشهري مكتمل ${brain.monthlyProgress}%`, `Aylık hedef %${brain.monthlyProgress} tamamlandı`),
      description: tr(locale, `${fmtK(gap)} remaining to target.`, `${fmtK(gap)} متبقية للهدف.`, `Hedefe ${fmtK(gap)} kaldı.`),
      reason: tr(locale, "Computed from won revenue vs. the monthly target.", "محسوب من الإيراد المكسوب مقابل الهدف الشهري.", "Kazanılan gelir ile aylık hedef karşılaştırmasından hesaplandı."),
      confidence: 65,
      signals: [tr(locale, `${fmtK(brain.monthlyActual)} of ${fmtK(brain.monthlyTarget)}`, `${fmtK(brain.monthlyActual)} من ${fmtK(brain.monthlyTarget)}`, `${fmtK(brain.monthlyTarget)} hedefin ${fmtK(brain.monthlyActual)}'i`)],
      recommendedAction: tr(locale, "Push closing-stage deals to close the gap", "ادفع صفقات مرحلة الإغلاق لسدّ الفجوة", "Açığı kapatmak için kapanış aşamasındaki anlaşmaları ilerlet"),
      cta: { label: tr(locale, "Open revenue brain", "افتح عقل الإيرادات", "Gelir beynini aç"), action: "scroll-revenue" },
      _score: gap * 0.4 + 300,
    });
  }

  candidates.sort((a, b) => b._score - a._score);
  return candidates.slice(0, 6).map((c, i) => {
    const { _score, ...action } = c;
    void _score;
    return { ...action, rank: i + 1 };
  });
}

// ── executive summary ────────────────────────────────────────────────────

export async function getExecutiveSummary(
  companyId: string,
  userName: string | null,
  locale: Locale = "en"
): Promise<AIExecutiveSummary> {
  const [actions, atRisk, stalled, brain] = await Promise.all([
    getPriorityActions(companyId, locale),
    atRiskCustomers(companyId),
    stalledDeals(companyId),
    getRevenueBrain(companyId, locale),
  ]);

  const revenueAtRisk =
    atRisk.reduce((s, c) => s + c.openValue, 0) + stalled.value;
  const opportunities = actions.filter((a) => a.type === "opportunity").length;

  const hourUTC = new Date().getUTCHours();
  const greetWord =
    hourUTC < 12
      ? tr(locale, "Good morning", "صباح الخير", "Günaydın")
      : hourUTC < 18
        ? tr(locale, "Good afternoon", "طاب يومك", "İyi günler")
        : tr(locale, "Good evening", "مساء الخير", "İyi akşamlar");
  const greeting = userName ? `${greetWord}, ${userName}` : greetWord;

  const oneLineNarrative = tr(
    locale,
    `You have ${actions.length} priorities. ${fmtK(revenueAtRisk)} at risk, ${opportunities} opportunities, and ${fmtK(brain.monthlyActual)} of ${fmtK(brain.monthlyTarget)} monthly target won.`,
    `لديك ${actions.length} أولويات. ${fmtK(revenueAtRisk)} في خطر، ${opportunities} فرص، و${fmtK(brain.monthlyActual)} من هدف ${fmtK(brain.monthlyTarget)} الشهري تم كسبه.`,
    `${actions.length} önceliğiniz var. ${fmtK(revenueAtRisk)} risk altında, ${opportunities} fırsat ve aylık ${fmtK(brain.monthlyTarget)} hedefin ${fmtK(brain.monthlyActual)}'i kazanıldı.`
  );

  return {
    greeting,
    oneLineNarrative,
    topPriorities: actions.length,
    revenueAtRisk: Math.round(revenueAtRisk),
    opportunities,
    confidence: brain.confidence,
    cta: [
      { label: tr(locale, "Show priorities", "عرض الأولويات", "Öncelikleri göster"), action: "scroll-priorities" },
      { label: tr(locale, "Open revenue brain", "فتح عقل الإيرادات", "Gelir beynini aç"), action: "scroll-revenue" },
      { label: tr(locale, "Ask AI", "اسأل الذكاء", "AI'a sor"), action: "open-ai-panel" },
    ],
  };
}
