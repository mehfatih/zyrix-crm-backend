// ============================================================================
// FEATURE FLAGS — per-company service enablement
// ----------------------------------------------------------------------------
// The Zyrix platform owner (us) can turn individual features on or off
// for any merchant from the admin panel. This is separate from plan
// tiers — it's a per-company override that lets us, for example:
//   • Pilot a new feature with a friendly subset of merchants
//   • Disable a broken area for one merchant while we fix their data
//   • Configure custom per-contract arrangements
//
// Storage: Company.enabledFeatures JSONB — a shallow map of feature
// keys to booleans. Missing keys fall through to the per-plan default
// (see defaultByPlan on each catalog entry). Every existing feature
// defaults to ON for every tier so nothing breaks for merchants who
// never had an override; premium P/B features are gated by tier.
// ============================================================================

import { prisma } from "../config/database";
import { badRequest, notFound } from "../middleware/errorHandler";

export type FeatureCategory =
  | "sales"
  | "growth"
  | "ai"
  | "ops"
  | "compliance"
  | "advanced"
  | "security"
  | "integrations"
  | "platform"
  | "ux";

export type PlanSlug = "free" | "starter" | "business" | "enterprise";

export interface FeatureDefinition {
  key: string;
  category: FeatureCategory;
  label: { en: string; ar: string; tr: string };
  description: { en: string; ar: string; tr: string };
  icon: string; // lucide-react icon name
  defaultByPlan: Record<PlanSlug, boolean>;
}

// Shorthand constants to keep the catalog readable.
const ALL_ON: Record<PlanSlug, boolean> = {
  free: true,
  starter: true,
  business: true,
  enterprise: true,
};
const STARTER_UP: Record<PlanSlug, boolean> = {
  free: false,
  starter: true,
  business: true,
  enterprise: true,
};
const BUSINESS_UP: Record<PlanSlug, boolean> = {
  free: false,
  starter: false,
  business: true,
  enterprise: true,
};
const ENTERPRISE_ONLY: Record<PlanSlug, boolean> = {
  free: false,
  starter: false,
  business: false,
  enterprise: true,
};

// ──────────────────────────────────────────────────────────────────────
// The canonical list of gate-able features. Keep this in sync with the
// admin UI; the admin page renders toggles for each entry here.
// ──────────────────────────────────────────────────────────────────────

export const FEATURE_CATALOG: FeatureDefinition[] = [
  // ─── Existing 12 (kept ALL_ON to preserve current behavior) ───
  {
    key: "quotes",
    category: "sales",
    label: { en: "Quotes", ar: "عروض الأسعار", tr: "Teklifler" },
    description: {
      en: "Create and send price quotes",
      ar: "إنشاء وإرسال عروض الأسعار",
      tr: "Fiyat teklifleri oluştur ve gönder",
    },
    icon: "FileText",
    defaultByPlan: ALL_ON,
  },
  {
    key: "contracts",
    category: "sales",
    label: { en: "Contracts", ar: "العقود", tr: "Sözleşmeler" },
    description: {
      en: "Contract management + e-signature",
      ar: "إدارة العقود + التوقيع الإلكتروني",
      tr: "Sözleşme yönetimi + e-imza",
    },
    icon: "FileSignature",
    defaultByPlan: ALL_ON,
  },
  {
    key: "loyalty",
    category: "growth",
    label: { en: "Loyalty", ar: "برنامج الولاء", tr: "Sadakat" },
    description: {
      en: "Points + tiers + rewards program",
      ar: "برنامج النقاط + المستويات + المكافآت",
      tr: "Puan + seviye + ödül programı",
    },
    icon: "Gift",
    defaultByPlan: ALL_ON,
  },
  {
    key: "ai_cfo",
    category: "ai",
    label: { en: "AI CFO", ar: "الذكاء الاصطناعي المالي", tr: "AI CFO" },
    description: {
      en: "AI-powered financial dashboard + insights",
      ar: "لوحة مالية مدعومة بالذكاء الاصطناعي",
      tr: "Yapay zeka destekli finansal panel",
    },
    icon: "Brain",
    defaultByPlan: ALL_ON,
  },
  {
    key: "marketing_automation",
    category: "growth",
    label: {
      en: "Marketing automation",
      ar: "أتمتة التسويق",
      tr: "Pazarlama otomasyonu",
    },
    description: {
      en: "Drip campaigns, workflows, broadcasts",
      ar: "حملات التنقيط، سير العمل، البث",
      tr: "Damla kampanyalar, iş akışları, yayınlar",
    },
    icon: "Megaphone",
    defaultByPlan: ALL_ON,
  },
  {
    key: "customer_portal",
    category: "ops",
    label: { en: "Customer portal", ar: "بوابة العميل", tr: "Müşteri portalı" },
    description: {
      en: "Self-service customer dashboard",
      ar: "لوحة تحكم ذاتية الخدمة للعميل",
      tr: "Self-servis müşteri paneli",
    },
    icon: "LayoutDashboard",
    defaultByPlan: ALL_ON,
  },
  {
    key: "tax_invoices",
    category: "compliance",
    label: {
      en: "Tax invoices",
      ar: "الفواتير الضريبية",
      tr: "Vergi faturaları",
    },
    description: {
      en: "ZATCA + e-Fatura compliance invoicing",
      ar: "فواتير متوافقة مع زاتكا + e-Fatura",
      tr: "ZATCA + e-Fatura uyumlu faturalar",
    },
    icon: "Receipt",
    defaultByPlan: ALL_ON,
  },
  {
    key: "multi_brand",
    category: "advanced",
    label: {
      en: "Multi-brand",
      ar: "علامات تجارية متعددة",
      tr: "Çoklu marka",
    },
    description: {
      en: "Manage multiple brands under one account",
      ar: "إدارة عدة علامات تجارية من حساب واحد",
      tr: "Tek hesapta birden fazla marka yönet",
    },
    icon: "Layers",
    defaultByPlan: ALL_ON,
  },
  {
    key: "analytics_reports",
    category: "advanced",
    label: {
      en: "Analytics reports",
      ar: "تقارير التحليلات",
      tr: "Analitik raporlar",
    },
    description: {
      en: "Pivot builder + scheduled email digests",
      ar: "منشئ تقارير + ملخصات بريد مجدولة",
      tr: "Pivot oluşturucu + zamanlanmış özet",
    },
    icon: "BarChart3",
    defaultByPlan: ALL_ON,
  },
  {
    key: "payments",
    category: "ops",
    label: { en: "Payments", ar: "المدفوعات", tr: "Ödemeler" },
    description: {
      en: "Payment links + Stripe + local gateways",
      ar: "روابط الدفع + Stripe + بوابات محلية",
      tr: "Ödeme bağlantıları + Stripe + yerel ağ geçitleri",
    },
    icon: "CreditCard",
    defaultByPlan: ALL_ON,
  },
  {
    key: "commission",
    category: "sales",
    label: { en: "Commission", ar: "العمولات", tr: "Komisyon" },
    description: {
      en: "Sales team commission tracking",
      ar: "تتبع عمولات فريق المبيعات",
      tr: "Satış ekibi komisyon takibi",
    },
    icon: "Coins",
    defaultByPlan: ALL_ON,
  },
  {
    key: "team_collaboration",
    category: "ops",
    label: {
      en: "Team collaboration",
      ar: "تعاون الفريق",
      tr: "Ekip işbirliği",
    },
    description: {
      en: "Notifications + comments + @mentions",
      ar: "إشعارات + تعليقات + إشارات",
      tr: "Bildirimler + yorumlar + bahsetmeler",
    },
    icon: "MessagesSquare",
    defaultByPlan: ALL_ON,
  },

  // ─── SECURITY & COMPLIANCE (premium tiers) ───
  {
    key: "rbac",
    category: "security",
    label: {
      en: "Role-based access control",
      ar: "التحكم في الوصول حسب الدور",
      tr: "Rol tabanlı erişim kontrolü",
    },
    description: {
      en: "Custom roles with fine-grained permissions",
      ar: "أدوار مخصصة مع صلاحيات تفصيلية",
      tr: "Ayrıntılı izinlerle özel roller",
    },
    icon: "Users",
    defaultByPlan: BUSINESS_UP,
  },
  {
    key: "ip_allowlist",
    category: "security",
    label: { en: "IP allowlisting", ar: "قائمة IP المسموحة", tr: "IP beyaz liste" },
    description: {
      en: "Restrict account access by IP / CIDR ranges",
      ar: "قصر الوصول إلى الحساب على نطاقات IP / CIDR",
      tr: "Hesap erişimini IP / CIDR aralıklarıyla sınırla",
    },
    icon: "Shield",
    defaultByPlan: ENTERPRISE_ONLY,
  },
  {
    key: "data_retention",
    category: "security",
    label: {
      en: "Data retention policies",
      ar: "سياسات الاحتفاظ بالبيانات",
      tr: "Veri saklama politikaları",
    },
    description: {
      en: "Configurable per-entity retention rules",
      ar: "قواعد احتفاظ قابلة للتكوين لكل كيان",
      tr: "Varlık bazında yapılandırılabilir saklama",
    },
    icon: "CalendarClock",
    defaultByPlan: ENTERPRISE_ONLY,
  },
  {
    key: "compliance_api",
    category: "security",
    label: {
      en: "Compliance API",
      ar: "واجهة الامتثال",
      tr: "Uyumluluk API",
    },
    description: {
      en: "GDPR / CCPA data export and deletion endpoints",
      ar: "نقاط تصدير وحذف بيانات GDPR / CCPA",
      tr: "GDPR / CCPA veri dışa aktarma ve silme uçları",
    },
    icon: "ScrollText",
    defaultByPlan: ENTERPRISE_ONLY,
  },
  {
    key: "scim_provisioning",
    category: "security",
    label: {
      en: "SCIM 2.0 provisioning",
      ar: "توفير SCIM 2.0",
      tr: "SCIM 2.0 sağlama",
    },
    description: {
      en: "Okta, Azure AD, and Google Workspace user sync",
      ar: "مزامنة المستخدمين مع Okta وAzure AD وGoogle Workspace",
      tr: "Okta, Azure AD ve Google Workspace kullanıcı senkronizasyonu",
    },
    icon: "KeyRound",
    defaultByPlan: ENTERPRISE_ONLY,
  },
  {
    key: "audit_advanced",
    category: "security",
    label: {
      en: "Advanced audit log",
      ar: "سجل التدقيق المتقدم",
      tr: "Gelişmiş denetim günlüğü",
    },
    description: {
      en: "Before/after diffs, CSV/JSON export, user + action filters",
      ar: "فروق قبل/بعد، تصدير CSV/JSON، مرشحات المستخدم والإجراء",
      tr: "Önce/sonra farkları, CSV/JSON dışa aktarma, kullanıcı + eylem filtreleri",
    },
    icon: "ScanSearch",
    defaultByPlan: BUSINESS_UP,
  },

  // ─── AI & AUTOMATION (premium) ───
  {
    key: "ai_workflows",
    category: "ai",
    label: {
      en: "AI workflow engine",
      ar: "محرك سير العمل بالذكاء الاصطناعي",
      tr: "AI iş akışı motoru",
    },
    description: {
      en: "Trigger-based automation with AI steps",
      ar: "أتمتة قائمة على المحفزات مع خطوات ذكاء اصطناعي",
      tr: "Tetiklemeye dayalı, AI adımlı otomasyon",
    },
    icon: "Workflow",
    defaultByPlan: BUSINESS_UP,
  },
  {
    key: "ai_build_modes",
    category: "ai",
    label: {
      en: "AI architect / builder / report",
      ar: "المهندس / المُنشئ / التقرير بالذكاء الاصطناعي",
      tr: "AI mimar / yapıcı / rapor",
    },
    description: {
      en: "Natural-language to workflows, templates, and configs",
      ar: "من اللغة الطبيعية إلى سير العمل والقوالب والإعدادات",
      tr: "Doğal dilden iş akışlarına, şablonlara ve yapılandırmalara",
    },
    icon: "Sparkles",
    defaultByPlan: BUSINESS_UP,
  },
  {
    key: "lead_scoring",
    category: "ai",
    label: {
      en: "Predictive lead scoring",
      ar: "تقييم تنبؤي للعملاء المحتملين",
      tr: "Tahmine dayalı müşteri adayı puanlaması",
    },
    description: {
      en: "AI-powered 0–100 score per customer",
      ar: "تقييم 0-100 لكل عميل مدعوم بالذكاء الاصطناعي",
      tr: "Müşteri başına AI destekli 0-100 puan",
    },
    icon: "Target",
    defaultByPlan: BUSINESS_UP,
  },
  {
    key: "conversation_intel",
    category: "ai",
    label: {
      en: "Conversation intelligence",
      ar: "ذكاء المحادثات",
      tr: "Konuşma zekası",
    },
    description: {
      en: "Sentiment analysis + buying-signal detection",
      ar: "تحليل المشاعر + رصد إشارات الشراء",
      tr: "Duygu analizi + satın alma sinyali tespiti",
    },
    icon: "MessageCircleMore",
    defaultByPlan: BUSINESS_UP,
  },
  {
    key: "duplicate_detection",
    category: "ai",
    label: {
      en: "Smart duplicate detection",
      ar: "كشف التكرارات الذكي",
      tr: "Akıllı yinelenen tespiti",
    },
    description: {
      en: "AI-powered dedup on create and import",
      ar: "إلغاء التكرار بالذكاء الاصطناعي عند الإنشاء والاستيراد",
      tr: "Oluşturma ve içe aktarmada AI destekli tekrar önleme",
    },
    icon: "CopyCheck",
    defaultByPlan: BUSINESS_UP,
  },
  {
    key: "meeting_intel",
    category: "ai",
    label: {
      en: "Meeting intelligence",
      ar: "ذكاء الاجتماعات",
      tr: "Toplantı zekası",
    },
    description: {
      en: "Meet / Zoom / Teams transcript ingestion + summaries",
      ar: "استيعاب نصوص Meet / Zoom / Teams مع ملخصات",
      tr: "Meet / Zoom / Teams transkript alımı ve özetler",
    },
    icon: "Mic",
    defaultByPlan: BUSINESS_UP,
  },

  // ─── SALES ADVANCED (premium) ───
  {
    key: "territories",
    category: "sales",
    label: {
      en: "Territory management",
      ar: "إدارة المناطق",
      tr: "Bölge yönetimi",
    },
    description: {
      en: "Geographic and segment-based assignment",
      ar: "التعيين الجغرافي والقطاعي",
      tr: "Coğrafi ve segment tabanlı atama",
    },
    icon: "Map",
    defaultByPlan: BUSINESS_UP,
  },
  {
    key: "quota_forecast",
    category: "sales",
    label: {
      en: "Quota & sales forecasting",
      ar: "حصص وتوقعات المبيعات",
      tr: "Kota ve satış tahmini",
    },
    description: {
      en: "Rep-level targets and pipeline predictions",
      ar: "أهداف على مستوى المندوب وتنبؤات المسار",
      tr: "Temsilci seviyesinde hedef ve pipeline tahminleri",
    },
    icon: "TrendingUp",
    defaultByPlan: BUSINESS_UP,
  },
  {
    key: "e_signature",
    category: "sales",
    label: {
      en: "Native e-signature",
      ar: "التوقيع الإلكتروني الأصلي",
      tr: "Yerel e-imza",
    },
    description: {
      en: "eIDAS and Saudi-compliant digital signing",
      ar: "توقيع رقمي متوافق مع eIDAS واللوائح السعودية",
      tr: "eIDAS ve Suudi uyumlu dijital imza",
    },
    icon: "PenLine",
    defaultByPlan: ENTERPRISE_ONLY,
  },
  {
    key: "health_score",
    category: "sales",
    label: {
      en: "Customer health score",
      ar: "مؤشر صحة العميل",
      tr: "Müşteri sağlık skoru",
    },
    description: {
      en: "At-risk detection for retention playbooks",
      ar: "كشف المخاطر لدعم خطط الاحتفاظ",
      tr: "Elde tutma senaryoları için risk tespiti",
    },
    icon: "HeartPulse",
    defaultByPlan: BUSINESS_UP,
  },

  // ─── INTEGRATIONS (premium) ───
  {
    key: "google_docs",
    category: "integrations",
    label: {
      en: "Google Docs cataloging",
      ar: "فهرسة Google Docs",
      tr: "Google Docs kataloglama",
    },
    description: {
      en: "Link and index Drive docs to customers and deals",
      ar: "ربط وفهرسة مستندات Drive للعملاء والصفقات",
      tr: "Drive belgelerini müşteri ve anlaşmalara bağla ve indeksle",
    },
    icon: "FolderOpen",
    defaultByPlan: ENTERPRISE_ONLY,
  },
  {
    key: "slack_teams",
    category: "integrations",
    label: {
      en: "Slack / MS Teams integration",
      ar: "تكامل Slack و MS Teams",
      tr: "Slack / MS Teams entegrasyonu",
    },
    description: {
      en: "Deep notifications and slash commands",
      ar: "إشعارات غنية وأوامر مائلة",
      tr: "Derin bildirimler ve slash komutları",
    },
    icon: "Slack",
    defaultByPlan: BUSINESS_UP,
  },

  // ─── PLATFORM (admin-controlled) ───
  {
    key: "network_controls",
    category: "platform",
    label: {
      en: "Network-level controls",
      ar: "ضوابط على مستوى الشبكة",
      tr: "Ağ seviyesi kontrolleri",
    },
    description: {
      en: "Geo-blocking, rate-limiting, DDoS protection",
      ar: "الحظر الجغرافي، تحديد المعدل، حماية DDoS",
      tr: "Coğrafi engelleme, hız sınırlama, DDoS koruması",
    },
    icon: "Globe",
    defaultByPlan: ALL_ON,
  },

  // ─── UX (usually on for all) ───
  {
    key: "onboarding_v2",
    category: "ux",
    label: {
      en: "New onboarding wizard",
      ar: "معالج الإعداد الجديد",
      tr: "Yeni onboarding sihirbazı",
    },
    description: {
      en: "Five-step independent-step onboarding flow",
      ar: "تدفق إعداد من خمس خطوات مستقلة",
      tr: "Beş adımlı bağımsız onboarding akışı",
    },
    icon: "Sparkle",
    defaultByPlan: ALL_ON,
  },
  {
    key: "mobile_responsive",
    category: "ux",
    label: {
      en: "Mobile-responsive web",
      ar: "واجهة متجاوبة للجوال",
      tr: "Mobil uyumlu web",
    },
    description: {
      en: "Fluid layouts across phones, tablets, and desktops",
      ar: "تخطيطات مرنة عبر الجوال والجهاز اللوحي وسطح المكتب",
      tr: "Telefon, tablet ve masaüstü genelinde akıcı düzenler",
    },
    icon: "Smartphone",
    defaultByPlan: ALL_ON,
  },
];

export type FeatureKey = (typeof FEATURE_CATALOG)[number]["key"];

// Fast lookup for the resolver.
const CATALOG_BY_KEY: Map<string, FeatureDefinition> = new Map(
  FEATURE_CATALOG.map((f) => [f.key, f])
);

function isPlanSlug(value: string): value is PlanSlug {
  return value === "free" || value === "starter" || value === "business" || value === "enterprise";
}

// ──────────────────────────────────────────────────────────────────────
// Read
// ──────────────────────────────────────────────────────────────────────

export async function getEnabledFeatures(
  companyId: string
): Promise<Record<string, boolean>> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT "enabledFeatures" FROM companies WHERE id = $1 LIMIT 1`,
    companyId
  )) as Array<{ enabledFeatures: unknown }>;
  if (rows.length === 0) throw notFound("Company");
  const raw = rows[0].enabledFeatures;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, boolean>;
}

async function getCompanyPlanSlug(companyId: string): Promise<PlanSlug> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT "plan" FROM companies WHERE id = $1 LIMIT 1`,
    companyId
  )) as Array<{ plan: string | null }>;
  const plan = rows[0]?.plan ?? "free";
  return isPlanSlug(plan) ? plan : "free";
}

/**
 * Resolve a feature's enabled state for a company.
 * Order of precedence:
 *   1. Per-company override in `enabledFeatures`
 *   2. Per-plan default from the catalog entry's `defaultByPlan`
 *   3. `true` (unknown key, never in catalog — don't block)
 */
export async function isFeatureEnabled(
  companyId: string,
  key: string
): Promise<boolean> {
  const [overrides, plan] = await Promise.all([
    getEnabledFeatures(companyId),
    getCompanyPlanSlug(companyId),
  ]);
  if (key in overrides) return overrides[key] === true;
  const def = CATALOG_BY_KEY.get(key);
  if (!def) return true; // unknown key — never block
  return def.defaultByPlan[plan] === true;
}

export async function getFullFeatureMap(
  companyId: string
): Promise<Record<string, boolean>> {
  const [overrides, plan] = await Promise.all([
    getEnabledFeatures(companyId),
    getCompanyPlanSlug(companyId),
  ]);
  const full: Record<string, boolean> = {};
  for (const def of FEATURE_CATALOG) {
    full[def.key] =
      def.key in overrides ? overrides[def.key] === true : def.defaultByPlan[plan];
  }
  return full;
}

// ──────────────────────────────────────────────────────────────────────
// Write — admin only (caller enforced via route gate)
// ──────────────────────────────────────────────────────────────────────

export async function setFeatureFlag(
  companyId: string,
  key: string,
  enabled: boolean
): Promise<Record<string, boolean>> {
  const valid = FEATURE_CATALOG.some((f) => f.key === key);
  if (!valid) throw badRequest(`Unknown feature: ${key}`);
  const current = await getEnabledFeatures(companyId);
  const next = { ...current, [key]: enabled };
  await prisma.$executeRawUnsafe(
    `UPDATE companies SET "enabledFeatures" = $1::jsonb, "updatedAt" = NOW()
     WHERE id = $2`,
    JSON.stringify(next),
    companyId
  );
  return getFullFeatureMap(companyId);
}

export async function setBulkFeatures(
  companyId: string,
  flags: Record<string, boolean>
): Promise<Record<string, boolean>> {
  for (const key of Object.keys(flags)) {
    if (!FEATURE_CATALOG.some((f) => f.key === key)) {
      throw badRequest(`Unknown feature: ${key}`);
    }
  }
  const current = await getEnabledFeatures(companyId);
  const next = { ...current, ...flags };
  await prisma.$executeRawUnsafe(
    `UPDATE companies SET "enabledFeatures" = $1::jsonb, "updatedAt" = NOW()
     WHERE id = $2`,
    JSON.stringify(next),
    companyId
  );
  return getFullFeatureMap(companyId);
}
