// ============================================================================
// CAC BENCHMARKS (Sprint 3, Phase 1) — STATIC, SOURCED industry reference data.
// ----------------------------------------------------------------------------
// Hand-curated industry CAC bands + a general "reduce-your-CAC" playbook, each
// carrying a human-readable source + year. These are CONSTANTS — never AI-
// generated, never fetched — so the recommendation engine can compare a tenant's
// real CAC to a sourced band without any hallucinated number.
//
// Bands are expressed in USD (the currency the public benchmarks are quoted in);
// the recommendation engine converts them to the tenant's base currency via the
// Sprint-23 FX engine before comparing. The playbook levers are GENERAL best
// practice (we have no cart/funnel/AOV feed), surfaced verbatim with citations —
// deliberately NOT dressed up as personalized analysis.
// ============================================================================

export interface Tri {
  en: string;
  ar: string;
  tr: string;
}
export type Locale = "en" | "ar" | "tr";
export function triPick(t: Tri, locale: Locale): string {
  return locale === "ar" ? t.ar : locale === "tr" ? t.tr : t.en;
}

export interface IndustryBenchmark {
  key: string;
  /** Lowercase keywords matched against Company.industry (first hit wins). */
  match: string[];
  label: Tri;
  lowUsd: number;
  highUsd: number;
  source: string;
  year: number;
}

// Ordered most-specific → most-general; pickBenchmark returns the first whose
// keywords appear in the tenant's industry string, else the generic e-commerce
// band (DEFAULT_BENCHMARK).
export const INDUSTRY_BENCHMARKS: IndustryBenchmark[] = [
  {
    key: "beauty_skincare",
    match: ["beauty", "skincare", "skin care", "skin", "cosmetic", "cosmetics", "makeup", "personal care"],
    label: { en: "Beauty & skincare (DTC)", ar: "التجميل والعناية بالبشرة (DTC)", tr: "Güzellik ve cilt bakımı (DTC)" },
    lowUsd: 25,
    highUsd: 50,
    source: "DTC beauty & skincare CAC benchmarks",
    year: 2025,
  },
  {
    key: "ecommerce_dtc",
    match: ["ecommerce", "e-commerce", "e commerce", "dtc", "d2c", "retail", "shop", "store", "fashion", "apparel", "consumer goods"],
    label: { en: "E-commerce / DTC (blended)", ar: "التجارة الإلكترونية / DTC (إجمالي)", tr: "E-ticaret / DTC (karma)" },
    lowUsd: 21,
    highUsd: 100,
    source: "DTC e-commerce blended CAC benchmarks",
    year: 2025,
  },
];

// Generic fallback when Company.industry is empty or unmatched: the broad DTC
// e-commerce band (clearly labeled as a general reference).
export const DEFAULT_BENCHMARK: IndustryBenchmark = {
  key: "general_dtc",
  match: [],
  label: { en: "E-commerce / DTC (general reference)", ar: "التجارة الإلكترونية / DTC (مرجع عام)", tr: "E-ticaret / DTC (genel referans)" },
  lowUsd: 21,
  highUsd: 100,
  source: "DTC e-commerce blended CAC benchmarks",
  year: 2025,
};

/** Pick the benchmark band for a tenant by keyword-matching Company.industry.
 *  Free-text industry → first band whose keywords appear, else DEFAULT_BENCHMARK. */
export function pickBenchmark(industry: string | null | undefined): IndustryBenchmark {
  const s = (industry || "").trim().toLowerCase();
  if (s) {
    for (const b of INDUSTRY_BENCHMARKS) {
      if (b.match.some((kw) => s.includes(kw))) return b;
    }
  }
  return DEFAULT_BENCHMARK;
}

export interface PlaybookLever {
  id: string;
  title: Tri;
  body: Tri;
  /** A sourced headline statistic shown as the "why". */
  stat: Tri;
  source: string;
  year: number;
}

// General, sourced best-practice levers. Presented as a "playbook" — explicitly
// NOT personalized (we have no cart/funnel/AOV data per tenant). The engine
// returns these verbatim so a merchant always sees credible, attributed advice.
export const PLAYBOOK_LEVERS: PlaybookLever[] = [
  {
    id: "cro",
    title: { en: "Conversion-rate optimization (CRO)", ar: "تحسين معدل التحويل (CRO)", tr: "Dönüşüm oranı optimizasyonu (CRO)" },
    body: {
      en: "More of your existing traffic converting means the same ad spend buys more customers — directly lowering CAC. Tighten landing pages, checkout, and page speed.",
      ar: "تحويل المزيد من زياراتك الحالية يعني أن نفس إنفاق الإعلانات يجلب عملاء أكثر — ما يخفّض تكلفة الاكتساب مباشرة. حسّن صفحات الهبوط والدفع وسرعة الصفحة.",
      tr: "Mevcut trafiğinizin daha fazlasının dönüşmesi, aynı reklam harcamasının daha fazla müşteri getirmesi demektir — CAC'ı doğrudan düşürür. Açılış sayfalarını, ödemeyi ve sayfa hızını iyileştirin.",
    },
    stat: {
      en: "Even a small lift in conversion rate can cut CAC proportionally.",
      ar: "حتى زيادة صغيرة في معدل التحويل قد تخفّض تكلفة الاكتساب بنسبة مماثلة.",
      tr: "Dönüşüm oranındaki küçük bir artış bile CAC'ı orantılı olarak düşürebilir.",
    },
    source: "CRO industry studies",
    year: 2025,
  },
  {
    id: "cart_recovery",
    title: { en: "Cart-abandonment recovery", ar: "استرداد السلات المتروكة", tr: "Sepet terk kurtarma" },
    body: {
      en: "Most shoppers who add to cart never check out. Automated email/WhatsApp recovery sequences win back a share of that demand you already paid to acquire.",
      ar: "معظم المتسوقين الذين يضيفون إلى السلة لا يكملون الشراء. تسلسلات الاسترداد التلقائية عبر البريد/واتساب تستعيد جزءًا من هذا الطلب الذي دفعت بالفعل لاكتسابه.",
      tr: "Sepete ekleyen alışverişçilerin çoğu ödemeyi tamamlamaz. Otomatik e-posta/WhatsApp kurtarma akışları, edinmek için zaten ödediğiniz talebin bir kısmını geri kazanır.",
    },
    stat: {
      en: "~70% of online shopping carts are abandoned.",
      ar: "‏~70% من سلات التسوق عبر الإنترنت تُترك.",
      tr: "Çevrimiçi alışveriş sepetlerinin ~%70'i terk edilir.",
    },
    source: "Baymard Institute",
    year: 2024,
  },
  {
    id: "aov_upsell",
    title: { en: "Raise AOV with upsell / cross-sell", ar: "ارفع متوسط قيمة الطلب بالبيع الإضافي/المتقاطع", tr: "Üst satış / çapraz satış ile AOV'yi artırın" },
    body: {
      en: "A higher average order value spreads the same acquisition cost across more revenue, improving your LTV:CAC even when CAC itself doesn't move. Bundle, upsell, and cross-sell at checkout.",
      ar: "ارتفاع متوسط قيمة الطلب يوزّع نفس تكلفة الاكتساب على إيراد أكبر، ما يحسّن نسبة LTV:CAC حتى لو لم تتغيّر التكلفة نفسها. استخدم الحزم والبيع الإضافي والمتقاطع عند الدفع.",
      tr: "Daha yüksek ortalama sipariş değeri, aynı edinme maliyetini daha fazla gelire yayar; CAC değişmese bile LTV:CAC oranınızı iyileştirir. Ödemede paketleme, üst satış ve çapraz satış yapın.",
    },
    stat: {
      en: "Upsell & cross-sell commonly lift average order value by 10–30%.",
      ar: "غالبًا ما يرفع البيع الإضافي والمتقاطع متوسط قيمة الطلب بنسبة 10–30%.",
      tr: "Üst satış ve çapraz satış genellikle ortalama sipariş değerini %10–30 artırır.",
    },
    source: "E-commerce merchandising studies",
    year: 2025,
  },
  {
    id: "ab_testing",
    title: { en: "Systematic A/B testing of creative & funnel", ar: "اختبار A/B منهجي للإبداع والمسار", tr: "Reklam ve hunide sistematik A/B testi" },
    body: {
      en: "Continuously testing ad creative, audiences, and landing pages compounds small wins into a materially lower cost per acquired customer over time.",
      ar: "اختبار الإبداع الإعلاني والجماهير وصفحات الهبوط باستمرار يراكم مكاسب صغيرة إلى تكلفة اكتساب أقل بشكل ملموس مع الوقت.",
      tr: "Reklam içeriğini, kitleleri ve açılış sayfalarını sürekli test etmek, küçük kazanımları zamanla belirgin şekilde daha düşük müşteri edinme maliyetine dönüştürür.",
    },
    stat: {
      en: "Disciplined A/B testing programs are reported to reduce CAC by ~20–40%.",
      ar: "تشير التقارير إلى أن برامج اختبار A/B المنضبطة تخفّض تكلفة الاكتساب بنحو 20–40%.",
      tr: "Disiplinli A/B test programlarının CAC'ı ~%20–40 azalttığı bildirilmektedir.",
    },
    source: "Paid-media testing studies",
    year: 2025,
  },
  {
    id: "owned_channels",
    title: { en: "Shift mix toward organic SEO & email", ar: "حوّل المزيج نحو SEO العضوي والبريد", tr: "Karışımı organik SEO ve e-postaya kaydırın" },
    body: {
      en: "Owned channels (SEO, email, referrals) carry a far lower marginal cost per customer than paid ads. Growing them lowers your blended CAC over time.",
      ar: "القنوات المملوكة (SEO، البريد، الإحالات) لها تكلفة هامشية لكل عميل أقل بكثير من الإعلانات المدفوعة. تنميتها تخفّض تكلفة الاكتساب الإجمالية مع الوقت.",
      tr: "Sahip olunan kanallar (SEO, e-posta, tavsiyeler), ücretli reklamlara kıyasla müşteri başına çok daha düşük marjinal maliyete sahiptir. Bunları büyütmek karma CAC'ınızı zamanla düşürür.",
    },
    stat: {
      en: "Owned channels are often several times cheaper per acquisition than paid.",
      ar: "غالبًا ما تكون القنوات المملوكة أرخص بعدة أضعاف لكل اكتساب مقارنة بالمدفوعة.",
      tr: "Sahip olunan kanallar, edinme başına genellikle ücretliden birkaç kat daha ucuzdur.",
    },
    source: "Channel cost benchmarks",
    year: 2025,
  },
];
