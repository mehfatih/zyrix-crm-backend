// ============================================================================
// CAC FORECAST + RECOMMENDATIONS (Sprint 3, Phase 1) — read-only consumer.
// ----------------------------------------------------------------------------
// CRITICAL ISOLATION CONTRACT: this module NEVER mutates the actual-CAC path. It
// is a pure READ-ONLY consumer of:
//   • computeMonthlyCac()  (Sprint 1, untouched)  — historical per-month spend +
//     new customers + per-platform + coverage.
//   • listPlanned()        (Sprint 2B, untouched) — scheduled future spend.
// It writes nothing and changes no CAC inputs, so the proven Sprint-1/2 byte-
// identical isolation holds (the verify asserts computeMonthlyCac is unchanged
// before vs after calling this service).
//
// FORECAST FRAMING (locked): under a constant linear conversion assumption,
// forecast CAC ≡ the trailing-window blended CAC. So we DO NOT pretend the
// forecast CAC "moves" with planned spend. Instead we project, from the trailing
// conversion efficiency:
//   • forecastCustomers = plannedSpendBase × conversionRate
//   • forecastTotalSpend = plannedSpendBase
//   • costPerCustomer    = trailing-window blended CAC ("at your current efficiency")
// Window = trailing N COMPLETED months (3 default, 6, or all) — the current month
// is partial/in-progress and is excluded from the conversion math (but surfaced
// separately for the dashboard widget's running figure).
//
// RECOMMENDATIONS are rule-based + deterministic (mirrors revenue-brain — numbers
// never go through Gemini): a benchmark comparison (sourced USD band → base via
// the FX engine) + personalized levers triggered ONLY when the tenant's own data
// supports them + a general sourced playbook. LTV:CAC is omitted in v1.
// ============================================================================

import { prisma } from "../config/database";
import { computeMonthlyCac, type CacSummary, type CacMonth } from "./cac.service";
import { listPlanned } from "./planned-spend.service";
import { getBaseCurrency, resolveRateToBase, type FxSource } from "./deal-economics.service";
import {
  pickBenchmark,
  PLAYBOOK_LEVERS,
  triPick,
  type Locale,
  type Tri,
} from "./cac-benchmarks";
import { readEnrichment, type EnrichmentItem } from "./cac-research.service";

export type ForecastWindow = 3 | 6 | "all";

// How far back we ask computeMonthlyCac to look so "all" has real history and the
// 3/6 windows always have enough completed months available (capped at its max 36).
const LOOKBACK_MONTHS = 24;

function round1(n: number): number {
  return Math.round((n + Number.EPSILON) * 10) / 10;
}
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Normalize an arbitrary input to a valid window (3 | 6 | "all"); default 3. */
export function parseWindow(v: unknown): ForecastWindow {
  if (v === "all") return "all";
  if (v === 6 || v === "6") return 6;
  if (v === 3 || v === "3") return 3;
  return 3;
}

function currentMonthKey(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}
function nextMonthKey(now = new Date()): string {
  const t = now.getUTCFullYear() * 12 + now.getUTCMonth() + 1;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

interface WindowAgg {
  baseCurrency: string;
  summary: CacSummary;
  window: ForecastWindow;
  slice: CacMonth[]; // trailing COMPLETED months in the window (chronological)
  windowFrom: string | null;
  windowTo: string | null;
  newCustomers: number;
  attributed: number;
  spendBase: number;
  spendUnconverted: number;
  conversionRate: number | null; // customers per 1 base unit of spend
  costPerCustomer: number | null; // trailing blended CAC ≡ forecast CAC
  coveragePct: number | null;
  hasHistory: boolean;
  completed: CacMonth[]; // all completed months (for last-completed point)
  current: CacMonth | null; // the in-progress current month
}

// Shared trailing-window aggregation used by BOTH the forecast and the
// recommendations. Pulls the Sprint-1 summary and slices COMPLETED months only.
async function windowAggregate(companyId: string, window: ForecastWindow): Promise<WindowAgg> {
  const summary = await computeMonthlyCac(companyId, LOOKBACK_MONTHS);
  const curKey = currentMonthKey();

  const completed = summary.months.filter((m) => m.month < curKey);
  const current = summary.months.find((m) => m.month === curKey) ?? null;

  // computeMonthlyCac returns EVERY calendar bucket (empty months included). For a
  // fixed 3/6 window we take the last N calendar months as-is (a spend-only month
  // must still count, pulling CAC honestly). For "all" we trim leading/trailing
  // empty months to the ACTIVE span so the reported window isn't padded with
  // dozens of zero months.
  const isActive = (m: CacMonth) => m.spendBase > 0 || m.newCustomers > 0 || m.spendUnconverted > 0;
  let slice: CacMonth[];
  if (window === "all") {
    let lo = 0;
    let hi = completed.length - 1;
    while (lo <= hi && !isActive(completed[lo])) lo++;
    while (hi >= lo && !isActive(completed[hi])) hi--;
    slice = lo <= hi ? completed.slice(lo, hi + 1) : [];
  } else {
    slice = completed.slice(Math.max(0, completed.length - window));
  }

  let newCustomers = 0;
  let attributed = 0;
  let spendBase = 0;
  let spendUnconverted = 0;
  for (const m of slice) {
    newCustomers += m.newCustomers;
    attributed += m.attributedCustomers;
    spendBase += m.spendBase;
    spendUnconverted += m.spendUnconverted;
  }
  spendBase = round2(spendBase);

  const hasHistory = newCustomers > 0 && spendBase > 0;
  const conversionRate = hasHistory ? newCustomers / spendBase : null;
  const costPerCustomer = hasHistory ? round2(spendBase / newCustomers) : null;
  const coveragePct = newCustomers > 0 ? round2((attributed / newCustomers) * 100) : null;

  return {
    baseCurrency: summary.baseCurrency,
    summary,
    window,
    slice,
    windowFrom: slice.length ? slice[0].month : null,
    windowTo: slice.length ? slice[slice.length - 1].month : null,
    newCustomers,
    attributed,
    spendBase,
    spendUnconverted,
    conversionRate,
    costPerCustomer,
    coveragePct,
    hasHistory,
    completed,
    current,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// FORECAST
// ─────────────────────────────────────────────────────────────────────────
export interface CacMonthPoint {
  month: string;
  newCustomers: number;
  spendBase: number;
  cac: number | null;
  spendComplete: boolean;
}

export interface CacForecast {
  baseCurrency: string;
  window: ForecastWindow;
  windowMonthsUsed: number;
  windowFrom: string | null;
  windowTo: string | null;

  // Trailing efficiency (the assumptions, shown honestly in the UI).
  hasHistory: boolean;
  windowNewCustomers: number;
  windowSpendBase: number;
  windowSpendUnconverted: number;
  conversionRate: number | null; // customers per 1 base-currency unit of spend
  costPerCustomer: number | null; // ≡ forecast CAC "at current efficiency"

  // Forecast target month (next calendar month).
  forecastMonth: string;
  plannedSpendBase: number; // planned spend scheduled for forecastMonth (converted rows)
  plannedUnconverted: number; // planned rows for that month with no FX estimate yet
  hasPlan: boolean;
  forecastCustomers: number | null; // plannedSpendBase × conversionRate (≈, an estimate)
  forecastTotalSpend: number | null; // = plannedSpendBase

  // Dashboard-widget triple.
  lastCompletedMonth: CacMonthPoint | null;
  currentMonth: CacMonthPoint | null; // in-progress / partial
}

function toPoint(m: CacMonth | null): CacMonthPoint | null {
  if (!m) return null;
  return {
    month: m.month,
    newCustomers: m.newCustomers,
    spendBase: m.spendBase,
    cac: m.cac,
    spendComplete: m.spendComplete,
  };
}

export async function computeCacForecast(
  companyId: string,
  window: ForecastWindow = 3
): Promise<CacForecast> {
  const agg = await windowAggregate(companyId, window);
  const forecastMonth = nextMonthKey();
  const forecastFirst = `${forecastMonth}-01`;

  // Planned spend scheduled for the forecast month (read-only; never enters CAC).
  const planned = await listPlanned(companyId);
  let plannedSpendBase = 0;
  let plannedUnconverted = 0;
  for (const p of planned) {
    if (p.periodMonth.slice(0, 7) !== forecastMonth) continue;
    if (p.amountBase == null) plannedUnconverted += 1;
    else plannedSpendBase += p.amountBase;
  }
  plannedSpendBase = round2(plannedSpendBase);
  const hasPlan = plannedSpendBase > 0;

  const forecastCustomers =
    agg.hasHistory && hasPlan && agg.conversionRate != null
      ? round1(plannedSpendBase * agg.conversionRate)
      : null;

  return {
    baseCurrency: agg.baseCurrency,
    window: agg.window,
    windowMonthsUsed: agg.slice.length,
    windowFrom: agg.windowFrom,
    windowTo: agg.windowTo,
    hasHistory: agg.hasHistory,
    windowNewCustomers: agg.newCustomers,
    windowSpendBase: agg.spendBase,
    windowSpendUnconverted: agg.spendUnconverted,
    conversionRate: agg.conversionRate,
    costPerCustomer: agg.costPerCustomer,
    forecastMonth,
    plannedSpendBase,
    plannedUnconverted,
    hasPlan,
    forecastCustomers,
    forecastTotalSpend: hasPlan ? plannedSpendBase : null,
    lastCompletedMonth: toPoint(agg.completed.length ? agg.completed[agg.completed.length - 1] : null),
    currentMonth: toPoint(agg.current),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// RECOMMENDATIONS (rule-based, deterministic)
// ─────────────────────────────────────────────────────────────────────────
export interface CacRecommendation {
  id: string;
  severity: "good" | "info" | "warn";
  title: string;
  body: string;
  metric?: string;
}

export interface CacBenchmarkView {
  industryLabel: string;
  lowUsd: number;
  highUsd: number;
  lowBase: number | null;
  highBase: number | null;
  fxSource: FxSource;
  blendedCac: number | null; // trailing-window blended CAC (base currency)
  status: "below" | "within" | "above" | "unknown";
  source: string;
  year: number;
}

// Optional live web-research enrichment (Sprint 3, Phase 2) attached to a playbook
// lever. DISPLAY-ONLY: text + citation links + the Google Search-Suggestions HTML
// (rendered sandboxed by the frontend). NEVER present when the shared cache has no
// items for this industry/topic, so an empty/disabled cache leaves the response
// byte-identical to Phase 1. No value here ever enters any CAC/forecast figure.
export interface CacPlaybookEnrichment {
  items: EnrichmentItem[];
  searchEntryPoint: string | null; // Google Suggestions HTML — must render WITH the items (ToS)
  fetchedAt: string; // ISO timestamp of the cached fetch
  stale: boolean; // cache expired or last refresh failed — UI may show a "last updated" note
}

export interface CacPlaybookItem {
  id: string;
  title: string;
  body: string;
  stat: string;
  source: string;
  year: number;
  enrichment?: CacPlaybookEnrichment; // absent unless real web-sourced items exist
}

export interface CacRecommendations {
  baseCurrency: string;
  window: ForecastWindow;
  windowMonthsUsed: number;
  hasHistory: boolean;
  benchmark: CacBenchmarkView;
  personalized: CacRecommendation[];
  playbook: CacPlaybookItem[];
  // For the "increase spend on X by Y" linear scenario (frontend math = spend ×
  // rate). Explicitly a SIMPLIFIED constant-conversion model.
  conversionRate: number | null;
  costPerCustomer: number | null;
  linearModel: true;
}

const COVERAGE_WARN_PCT = 60; // below this we suggest improving attribution
const DISPERSION_RATIO = 1.5; // max-CAC ≥ this × min-CAC → suggest shifting budget

function platformLabel(p: string, locale: Locale): string {
  const map: Record<string, Tri> = {
    meta: { en: "Meta", ar: "ميتا", tr: "Meta" },
    google: { en: "Google Ads", ar: "إعلانات جوجل", tr: "Google Ads" },
    tiktok: { en: "TikTok", ar: "تيك توك", tr: "TikTok" },
    snapchat: { en: "Snapchat", ar: "سناب شات", tr: "Snapchat" },
    twitter: { en: "X (Twitter)", ar: "إكس (تويتر)", tr: "X (Twitter)" },
    linkedin: { en: "LinkedIn", ar: "لينكدإن", tr: "LinkedIn" },
  };
  const t = map[p];
  return t ? triPick(t, locale) : p;
}

export async function computeCacRecommendations(
  companyId: string,
  locale: Locale = "en",
  window: ForecastWindow = 3
): Promise<CacRecommendations> {
  const agg = await windowAggregate(companyId, window);
  const base = agg.baseCurrency;
  const tr = (en: string, ar: string, trk: string) => (locale === "ar" ? ar : locale === "tr" ? trk : en);

  // ── Benchmark band (sourced USD) → base currency via the FX engine ──
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { industry: true } });
  const band = pickBenchmark(company?.industry);
  const { rate, source: fxSource } = await resolveRateToBase(companyId, "USD", base, new Date());
  const lowBase = rate != null ? round2(band.lowUsd * rate) : null;
  const highBase = rate != null ? round2(band.highUsd * rate) : null;

  const blended = agg.costPerCustomer; // trailing-window blended CAC in base
  let status: CacBenchmarkView["status"] = "unknown";
  if (blended != null && lowBase != null && highBase != null) {
    status = blended < lowBase ? "below" : blended > highBase ? "above" : "within";
  }

  const benchmark: CacBenchmarkView = {
    industryLabel: triPick(band.label, locale),
    lowUsd: band.lowUsd,
    highUsd: band.highUsd,
    lowBase,
    highBase,
    fxSource,
    blendedCac: blended,
    status,
    source: band.source,
    year: band.year,
  };

  // ── Personalized, data-triggered recommendations ──
  const personalized: CacRecommendation[] = [];
  const fmt = (n: number) => `${n.toLocaleString("en-US")} ${base}`;

  // (1) Benchmark position — only when we could actually compare.
  if (status === "above" && blended != null && highBase != null) {
    personalized.push({
      id: "benchmark_above",
      severity: "warn",
      title: tr("Your CAC is above the typical range", "تكلفة اكتسابك أعلى من النطاق المعتاد", "CAC'ınız tipik aralığın üzerinde"),
      body: tr(
        `Your blended CAC (${fmt(blended)}) is above the ${benchmark.industryLabel} band of ${fmt(lowBase!)}–${fmt(highBase!)}. The levers below are where most teams find room.`,
        `تكلفة اكتسابك الإجمالية (${fmt(blended)}) أعلى من نطاق ${benchmark.industryLabel} البالغ ${fmt(lowBase!)}–${fmt(highBase!)}. الروافع أدناه هي حيث يجد معظم الفرق مجالاً للتحسين.`,
        `Karma CAC'ınız (${fmt(blended)}), ${benchmark.industryLabel} bandının (${fmt(lowBase!)}–${fmt(highBase!)}) üzerinde. Aşağıdaki kaldıraçlar çoğu ekibin iyileştirme alanı bulduğu yerlerdir.`,
      ),
      metric: `${fmt(blended)} > ${fmt(highBase!)}`,
    });
  } else if (status === "below" && blended != null && lowBase != null) {
    personalized.push({
      id: "benchmark_below",
      severity: "good",
      title: tr("Your CAC is below the typical range", "تكلفة اكتسابك أقل من النطاق المعتاد", "CAC'ınız tipik aralığın altında"),
      body: tr(
        `Your blended CAC (${fmt(blended)}) is below the ${benchmark.industryLabel} band's low end (${fmt(lowBase)}). You may have room to scale spend while staying efficient.`,
        `تكلفة اكتسابك الإجمالية (${fmt(blended)}) أقل من الحد الأدنى لنطاق ${benchmark.industryLabel} (${fmt(lowBase)}). قد يكون لديك مجال لزيادة الإنفاق مع الحفاظ على الكفاءة.`,
        `Karma CAC'ınız (${fmt(blended)}), ${benchmark.industryLabel} bandının alt sınırının (${fmt(lowBase)}) altında. Verimli kalırken harcamayı ölçeklendirme alanınız olabilir.`,
      ),
      metric: `${fmt(blended)} < ${fmt(lowBase)}`,
    });
  }

  // (2) Channel-CAC dispersion → shift budget to the cheaper channel.
  const chan = new Map<string, { spend: number; cust: number }>();
  for (const m of agg.slice) {
    for (const p of m.platforms) {
      const cur = chan.get(p.platform) ?? { spend: 0, cust: 0 };
      cur.spend += p.spendBase;
      cur.cust += p.newCustomers;
      chan.set(p.platform, cur);
    }
  }
  const channelCacs = [...chan.entries()]
    .filter(([, v]) => v.cust > 0 && v.spend > 0)
    .map(([platform, v]) => ({ platform, cac: round2(v.spend / v.cust) }));
  if (channelCacs.length >= 2) {
    const cheapest = channelCacs.reduce((a, b) => (b.cac < a.cac ? b : a));
    const priciest = channelCacs.reduce((a, b) => (b.cac > a.cac ? b : a));
    if (priciest.cac >= cheapest.cac * DISPERSION_RATIO) {
      personalized.push({
        id: "channel_shift",
        severity: "warn",
        title: tr("Rebalance budget toward your cheapest channel", "أعد توازن الميزانية نحو قناتك الأرخص", "Bütçeyi en ucuz kanalınıza doğru dengeleyin"),
        body: tr(
          `${platformLabel(priciest.platform, locale)} is acquiring customers at ${fmt(priciest.cac)} vs ${platformLabel(cheapest.platform, locale)} at ${fmt(cheapest.cac)}. Shifting budget toward ${platformLabel(cheapest.platform, locale)} should lower your blended CAC — within that channel's capacity.`,
          `يكتسب ${platformLabel(priciest.platform, locale)} العملاء بتكلفة ${fmt(priciest.cac)} مقابل ${platformLabel(cheapest.platform, locale)} بتكلفة ${fmt(cheapest.cac)}. تحويل الميزانية نحو ${platformLabel(cheapest.platform, locale)} يُفترض أن يخفّض تكلفتك الإجمالية — ضمن سعة تلك القناة.`,
          `${platformLabel(priciest.platform, locale)} müşterileri ${fmt(priciest.cac)} maliyetle ediniyor; ${platformLabel(cheapest.platform, locale)} ise ${fmt(cheapest.cac)}. Bütçeyi ${platformLabel(cheapest.platform, locale)} kanalına kaydırmak — o kanalın kapasitesi dahilinde — karma CAC'ınızı düşürmelidir.`,
        ),
        metric: `${platformLabel(priciest.platform, locale)} ${fmt(priciest.cac)} · ${platformLabel(cheapest.platform, locale)} ${fmt(cheapest.cac)}`,
      });
    }
  }

  // (3) Low attribution coverage → improve attribution.
  if (agg.newCustomers > 0 && agg.coveragePct != null && agg.coveragePct < COVERAGE_WARN_PCT) {
    personalized.push({
      id: "low_coverage",
      severity: "warn",
      title: tr("Improve channel attribution", "حسّن إسناد القنوات", "Kanal ilişkilendirmesini iyileştirin"),
      body: tr(
        `Only ${agg.coveragePct}% of your new customers are attributed to a channel, so per-channel CAC is based on partial data. Tag more deals and enable source capture for a clearer picture.`,
        `فقط ${agg.coveragePct}% من عملائك الجدد مُسندون إلى قناة، لذا تعتمد تكلفة كل قناة على بيانات جزئية. أسند مزيدًا من الصفقات وفعّل التقاط المصدر لصورة أوضح.`,
        `Yeni müşterilerinizin yalnızca %${agg.coveragePct}'i bir kanala atfedildi, bu nedenle kanal bazlı CAC kısmi veriye dayanıyor. Daha net bir tablo için daha fazla anlaşmayı etiketleyin ve kaynak yakalamayı etkinleştirin.`,
      ),
      metric: `${agg.coveragePct}% ${tr("attributed", "مُسند", "atfedildi")}`,
    });
  }

  // (4) Unconverted spend in the window → set FX rates so totals are complete.
  if (agg.spendUnconverted > 0) {
    personalized.push({
      id: "unconverted_spend",
      severity: "warn",
      title: tr("Some spend has no exchange rate", "بعض الإنفاق بلا سعر صرف", "Bazı harcamaların kuru yok"),
      body: tr(
        `${agg.spendUnconverted} spend/cost row(s) in this window have no exchange rate yet and are excluded from your CAC. Set a rate so your blended CAC is complete and comparable.`,
        `${agg.spendUnconverted} صف من الإنفاق/التكاليف في هذه الفترة بلا سعر صرف بعد ومستبعد من تكلفتك. حدّد سعرًا لتكون تكلفتك الإجمالية مكتملة وقابلة للمقارنة.`,
        `Bu penceredeki ${agg.spendUnconverted} harcama/maliyet satırının henüz kuru yok ve CAC'ınızdan hariç. Karma CAC'ınızın eksiksiz ve karşılaştırılabilir olması için bir kur belirleyin.`,
      ),
      metric: `${agg.spendUnconverted} ${tr("row(s)", "صف", "satır")}`,
    });
  }

  // ── General sourced playbook (localized passthrough; NOT personalized) ──
  // Optionally decorated with live web-research enrichment (Phase 2). The cache read
  // is a PURE SELECT, keyed by the SAME benchmark band; it is fail-safe (any error →
  // no enrichment) and EN-only in v1. When the shared cache has no items for a topic,
  // the playbook item is returned UNCHANGED, so an empty/disabled cache leaves this
  // response byte-identical to Phase 1. Enrichment NEVER touches any number above.
  let research: Awaited<ReturnType<typeof readEnrichment>> = new Map();
  try {
    research = await readEnrichment(band.key, "en");
  } catch {
    research = new Map(); // degrade silently to Phase-1-only output
  }
  const playbook: CacPlaybookItem[] = PLAYBOOK_LEVERS.map((l) => {
    const item: CacPlaybookItem = {
      id: l.id,
      title: triPick(l.title, locale),
      body: triPick(l.body, locale),
      stat: triPick(l.stat, locale),
      source: l.source,
      year: l.year,
    };
    const row = research.get(l.id);
    if (row && row.items.length > 0) {
      item.enrichment = {
        items: row.items,
        searchEntryPoint: row.searchEntryPoint,
        fetchedAt: row.fetchedAt instanceof Date ? row.fetchedAt.toISOString() : String(row.fetchedAt),
        stale: row.stale,
      };
    }
    return item;
  });

  return {
    baseCurrency: base,
    window: agg.window,
    windowMonthsUsed: agg.slice.length,
    hasHistory: agg.hasHistory,
    benchmark,
    personalized,
    playbook,
    conversionRate: agg.conversionRate,
    costPerCustomer: agg.costPerCustomer,
    linearModel: true,
  };
}
