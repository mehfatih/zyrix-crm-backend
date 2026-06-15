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
  | "ux"
  | "limits";

export type PlanSlug = "free" | "starter" | "business" | "enterprise";

// Sprint 16 — features are either booleans (have / don't have) or numeric
// LIMITS (users, contacts, storage, ...). For a limit feature, `defaultByPlan`
// still answers "does this plan have the capability at all" (limit !== 0) and
// `limitByPlan` carries the numeric cap (null = unlimited).
export type FeatureType = "boolean" | "limit";

export interface FeatureDefinition {
  key: string;
  category: FeatureCategory;
  label: { en: string; ar: string; tr: string };
  description: { en: string; ar: string; tr: string };
  icon: string; // lucide-react icon name
  defaultByPlan: Record<PlanSlug, boolean>;
  // Defaults to "boolean" when omitted.
  type?: FeatureType;
  // Required for type === "limit". null = unlimited for that plan.
  limitByPlan?: Record<PlanSlug, number | null>;
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
    // Sprint 15A — quote e-signature. ALL_ON for now; Sprint 16 retunes the
    // plan tier + admin per-tenant toggle (already rendered from this catalog).
    key: "quote_esign",
    category: "sales",
    label: { en: "Quote e-signature", ar: "التوقيع الإلكتروني للعروض", tr: "Teklif e-imzası" },
    description: {
      en: "Customers sign quotes online; signature stamped on the PDF",
      ar: "يوقّع العملاء العروض أونلاين؛ التوقيع مختوم على PDF",
      tr: "Müşteriler teklifleri online imzalar; imza PDF'e basılır",
    },
    icon: "FileSignature",
    defaultByPlan: ALL_ON,
  },
  {
    // Sprint 15B — live FX conversion in multi-currency reports. ALL_ON now;
    // off → reports fall back to the manual/DEFAULT conversion chain.
    key: "live_fx",
    category: "sales",
    label: { en: "Live FX conversion", ar: "تحويل عملات حي", tr: "Canlı döviz çevirisi" },
    description: {
      en: "Reports convert currencies using daily live exchange rates",
      ar: "تحوّل التقارير العملات بأسعار صرف حية يومية",
      tr: "Raporlar para birimlerini günlük canlı kurlarla çevirir",
    },
    icon: "Coins",
    defaultByPlan: ALL_ON,
  },
  {
    // Sprint 15C — inbound email replies (email.replied + AI suggested reply).
    key: "email_replies",
    category: "growth",
    label: { en: "Email reply detection", ar: "كشف ردود الإيميل", tr: "E-posta yanıt algılama" },
    description: {
      en: "Detect customer email replies and suggest an AI response",
      ar: "اكشف ردود العملاء على الإيميل واقترح ردًا بالذكاء الاصطناعي",
      tr: "Müşteri e-posta yanıtlarını algıla ve AI yanıtı öner",
    },
    icon: "Mail",
    defaultByPlan: ALL_ON,
  },
  {
    // Sprint 15D — connect Gmail/IMAP inbox; mail lands in the contact timeline.
    key: "email_inbox",
    category: "integrations",
    label: { en: "Email inbox connect", ar: "ربط صندوق البريد", tr: "E-posta gelen kutusu bağlantısı" },
    description: {
      en: "Connect Gmail or an IMAP inbox to track conversations in the CRM",
      ar: "اربط Gmail أو صندوق IMAP لتتبع المحادثات في الـ CRM",
      tr: "Konuşmaları CRM'de izlemek için Gmail veya IMAP gelen kutusu bağlayın",
    },
    icon: "Mail",
    defaultByPlan: ALL_ON,
  },
  {
    // Sprint 21 — connect Google Calendar; CRM meetings sync two-way. SEPARATE
    // OAuth flow (calendar.events) mirroring 15D. STARTER_UP, consistent with
    // the other connect-an-account integrations (email_inbox, service_desk).
    key: "calendar_sync",
    category: "integrations",
    label: { en: "Calendar sync", ar: "مزامنة التقويم", tr: "Takvim senkronizasyonu" },
    description: {
      en: "Connect Google Calendar — CRM meetings sync two-way (with Meet links)",
      ar: "اربط Google Calendar — تتزامن اجتماعات الـ CRM في الاتجاهين (مع روابط Meet)",
      tr: "Google Takvim'i bağla — CRM toplantıları çift yönlü senkronize olur (Meet bağlantılarıyla)",
    },
    icon: "Calendar",
    defaultByPlan: STARTER_UP,
  },
  {
    // Omnichannel inbox — unified WhatsApp/Messenger/Instagram inbox. ALL_ON to
    // preserve current behavior. NOTE: this is an ENTITLEMENT toggle only; actual
    // go-live also requires the platform WhatsApp Cloud API envs (META_APP_SECRET
    // + WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID). Off → /inbox hidden +
    // its routes 403; on-but-unprovisioned → the inbox shows a "contact support"
    // upsell instead of a dead Connect button.
    key: "whatsapp",
    category: "integrations",
    label: { en: "WhatsApp / Omnichannel inbox", ar: "واتساب / الصندوق الموحّد", tr: "WhatsApp / Çoklu kanal gelen kutusu" },
    description: {
      en: "Unified WhatsApp, Messenger & Instagram inbox (requires platform WhatsApp provisioning)",
      ar: "صندوق موحّد لواتساب وماسنجر وإنستغرام (يتطلب تجهيز واتساب على المنصة)",
      tr: "Birleşik WhatsApp, Messenger ve Instagram gelen kutusu (platform WhatsApp kurulumu gerektirir)",
    },
    icon: "MessageCircle",
    defaultByPlan: ALL_ON,
  },
  {
    // Sprint 15E — collect payments on quotes via iyzico/HyperPay.
    key: "payments_collect",
    category: "integrations",
    label: { en: "Payment collection", ar: "تحصيل المدفوعات", tr: "Ödeme tahsilatı" },
    description: {
      en: "Collect payment on quotes via iyzico (TRY) or HyperPay (SAR/AED)",
      ar: "حصّل المدفوعات على العروض عبر iyzico (TRY) أو HyperPay (SAR/AED)",
      tr: "Tekliflerde iyzico (TRY) veya HyperPay (SAR/AED) ile ödeme tahsil edin",
    },
    icon: "CreditCard",
    defaultByPlan: ALL_ON,
  },
  {
    // Sprint 22 — let customers pay open quotes from inside the portal. Reuses the
    // Sprint-15E payments-collect rails (payments_collect must also be on for the
    // underlying connection/checkout to exist); this key gates the portal surface.
    key: "portal_payments",
    category: "integrations",
    label: { en: "Portal payments", ar: "مدفوعات البوابة", tr: "Portal ödemeleri" },
    description: {
      en: "Let customers pay open quotes from the customer portal (Pay now)",
      ar: "اسمح للعملاء بدفع عروض الأسعار المفتوحة من بوابة العملاء (ادفع الآن)",
      tr: "Müşterilerin açık teklifleri müşteri portalından ödemesine izin ver (Şimdi öde)",
    },
    icon: "CreditCard",
    defaultByPlan: STARTER_UP,
  },
  {
    // Sprint 15F — real Gemini message composer (grounded on contact context).
    key: "ai_messaging",
    category: "ai",
    label: { en: "AI message composer", ar: "محرّر رسائل بالذكاء", tr: "AI mesaj oluşturucu" },
    description: {
      en: "Draft emails and WhatsApp messages with AI, grounded on the contact",
      ar: "صُغ رسائل البريد وواتساب بالذكاء الاصطناعي، مبنية على جهة الاتصال",
      tr: "Kişiye dayalı olarak AI ile e-posta ve WhatsApp mesajları taslakla",
    },
    icon: "Sparkles",
    defaultByPlan: ALL_ON,
  },
  {
    // Sprint 15F — real AI Agents v1 (lead-qualification scoring + reasoning).
    key: "ai_agents",
    category: "ai",
    label: { en: "AI Agents", ar: "وكلاء الذكاء", tr: "AI Ajanları" },
    description: {
      en: "AI agents that qualify and score new leads with reasoning",
      ar: "وكلاء ذكاء يصنّفون ويقيّمون العملاء المحتملين الجدد مع التعليل",
      tr: "Yeni adayları gerekçeyle niteleyen ve puanlayan AI ajanları",
    },
    icon: "Bot",
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
    // Sprint 23 — Deal Economics. Gates the per-deal profitability surface
    // (base-currency revenue / COGS / variable costs / commission / gross
    // profit / margin%). BUSINESS_UP, alongside the other finance-grade
    // analytics (ai_cfo, tax_engine). The FX stamp + cost snapshots are
    // CAPTURED on every close regardless of plan; only the read surface +
    // variable-cost editing are gated — so upgrading retroactively lights up
    // historical deals' profit.
    key: "deal_economics",
    category: "sales",
    label: { en: "Deal profitability", ar: "ربحية الصفقات", tr: "Anlaşma kârlılığı" },
    description: {
      en: "Real gross profit & margin per deal in your base currency (frozen FX + COGS)",
      ar: "الربح الإجمالي والهامش الفعلي لكل صفقة بعملتك الأساسية (سعر صرف مجمّد + تكلفة البضاعة)",
      tr: "Temel para biriminizde anlaşma başına gerçek brüt kâr ve marj (dondurulmuş kur + SMM)",
    },
    icon: "TrendingUp",
    defaultByPlan: BUSINESS_UP,
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

  // ─── SERVICE DESK (Sprint 18) ───
  // Distinct from the platform `sla` uptime-guarantee key (enterprise-only).
  {
    key: "service_desk",
    category: "ops",
    label: { en: "Service desk", ar: "مكتب خدمة العملاء", tr: "Servis masası" },
    description: {
      en: "Turn inbound conversations & emails into tracked support tickets",
      ar: "تحويل المحادثات والرسائل الواردة إلى تذاكر دعم متابَعة",
      tr: "Gelen konuşma ve e-postaları takip edilen destek taleplerine dönüştür",
    },
    icon: "Headset",
    defaultByPlan: STARTER_UP,
  },
  {
    key: "service_sla",
    category: "ops",
    label: { en: "Service SLA", ar: "اتفاقية مستوى الخدمة", tr: "Servis SLA" },
    description: {
      en: "First-response & resolution timers with breach escalation",
      ar: "مؤقتات الرد الأول والحل مع تصعيد عند الإخلال",
      tr: "İlk yanıt ve çözüm süreleri, ihlal halinde yükseltme",
    },
    icon: "Timer",
    defaultByPlan: BUSINESS_UP,
  },
  {
    key: "service_routing",
    category: "ops",
    label: { en: "Ticket routing", ar: "توجيه التذاكر", tr: "Talep yönlendirme" },
    description: {
      en: "Auto-assign tickets to agents (round-robin)",
      ar: "إسناد التذاكر تلقائيًا للوكلاء (بالتناوب)",
      tr: "Talepleri temsilcilere otomatik ata (sırayla)",
    },
    icon: "Users",
    defaultByPlan: BUSINESS_UP,
  },
  {
    key: "knowledge_base",
    category: "ops",
    label: { en: "Knowledge base", ar: "قاعدة المعرفة", tr: "Bilgi tabanı" },
    description: {
      en: "Trilingual help articles for the customer portal + AI grounding",
      ar: "مقالات مساعدة ثلاثية اللغة لبوابة العملاء + تأسيس إجابات الذكاء الاصطناعي",
      tr: "Müşteri portalı için üç dilli yardım makaleleri + yapay zekâ temellendirme",
    },
    icon: "BookOpen",
    defaultByPlan: STARTER_UP,
  },

  // ─── LANDING PAGES (Sprint 20) ───
  // Ads-ready hosted campaign pages. LIMIT feature: starter gets 1 page,
  // business+ unlimited (free off). The page cap is enforced at create-time
  // via enforceLimit("landing_pages", count). defaultByPlan answers "has the
  // capability at all" (limit !== 0); limitByPlan carries the cap.
  {
    key: "landing_pages",
    category: "growth",
    label: { en: "Landing pages", ar: "صفحات الهبوط", tr: "Açılış sayfaları" },
    description: {
      en: "Build & publish hosted campaign landing pages (AI copy + form CTA)",
      ar: "أنشئ وانشر صفحات هبوط للحملات مستضافة (نسخ بالذكاء الاصطناعي + نموذج)",
      tr: "Barındırılan kampanya açılış sayfaları oluştur ve yayınla (yapay zekâ metni + form)",
    },
    icon: "LayoutTemplate",
    type: "limit",
    defaultByPlan: STARTER_UP,
    limitByPlan: { free: 0, starter: 1, business: null, enterprise: null },
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

  // ════════════════════════════════════════════════════════════════════
  // Sprint 16 — additions: marketing-comparison rows promoted to canonical
  // entitlement keys (so /pricing display + enforcement share one truth),
  // plus numeric LIMIT features. defaultByPlan tuned to match the marketing
  // pricing matrix (lib/billing/plan-catalog.ts). See PLAN_RETUNE below for
  // the existing keys whose tier changed in this sprint.
  // ════════════════════════════════════════════════════════════════════

  // ─── SALES / CPQ ───
  {
    key: "price_books",
    category: "sales",
    label: { en: "Price books & bundles", ar: "قوائم الأسعار والباقات", tr: "Fiyat listeleri ve paketler" },
    description: {
      en: "Segment price books and product bundles for CPQ",
      ar: "قوائم أسعار حسب الشريحة وباقات المنتجات للتسعير",
      tr: "CPQ için segment fiyat listeleri ve ürün paketleri",
    },
    icon: "BookOpen",
    defaultByPlan: STARTER_UP,
  },
  {
    key: "discount_approvals",
    category: "sales",
    label: { en: "Discount approvals + AI suggestions", ar: "موافقات الخصم + اقتراحات الذكاء", tr: "İndirim onayları + AI önerileri" },
    description: {
      en: "Discount governance with approval routing and AI price hints",
      ar: "حوكمة الخصومات مع مسار الموافقات واقتراحات سعر بالذكاء",
      tr: "Onay yönlendirme ve AI fiyat ipuçlarıyla indirim yönetimi",
    },
    icon: "BadgePercent",
    defaultByPlan: BUSINESS_UP,
  },

  // ─── GROWTH ───
  {
    key: "email_tracking",
    category: "growth",
    label: { en: "Email open/click tracking", ar: "تتبع فتح/ضغط الإيميل", tr: "E-posta açılma/tıklama takibi" },
    description: {
      en: "Track opens, clicks and best-send-time on CRM emails",
      ar: "تتبع الفتح والنقر وأفضل وقت إرسال لرسائل الـ CRM",
      tr: "CRM e-postalarında açılma, tıklama ve en iyi gönderim saatini izle",
    },
    icon: "MailOpen",
    defaultByPlan: STARTER_UP,
  },
  {
    key: "forms",
    category: "growth",
    label: { en: "Forms & kiosks", ar: "النماذج والأكشاك", tr: "Formlar ve kiosklar" },
    description: {
      en: "Public form flows, guided entry and kiosk capture",
      ar: "نماذج عامة وإدخال موجّه والتقاط عبر الكشك",
      tr: "Herkese açık form akışları, yönlendirilmiş giriş ve kiosk yakalama",
    },
    icon: "ClipboardList",
    defaultByPlan: STARTER_UP,
  },

  // ─── AI ───
  {
    key: "custom_actions",
    category: "ai",
    label: { en: "Custom Actions (recipes)", ar: "إجراءات مخصصة (وصفات)", tr: "Özel Eylemler (tarifler)" },
    description: {
      en: "No-code action recipes: webhooks, computed fields, conditional updates",
      ar: "وصفات إجراءات بدون كود: webhooks وحقول محسوبة وتحديثات شرطية",
      tr: "Kodsuz eylem tarifleri: webhook'lar, hesaplanan alanlar, koşullu güncellemeler",
    },
    icon: "Zap",
    defaultByPlan: BUSINESS_UP,
  },
  {
    key: "ai_studio",
    category: "ai",
    label: { en: "AI Studio — company voice", ar: "استوديو الذكاء — صوت الشركة", tr: "AI Stüdyo — şirket sesi" },
    description: {
      en: "Tune the company AI personality injected into generative replies",
      ar: "اضبط شخصية الذكاء للشركة المحقونة في الردود التوليدية",
      tr: "Üretken yanıtlara enjekte edilen şirket AI kişiliğini ayarla",
    },
    icon: "Palette",
    defaultByPlan: BUSINESS_UP,
  },
  {
    key: "scheduled_ai_reports",
    category: "ai",
    label: { en: "Scheduled AI reports", ar: "تقارير ذكاء مجدولة", tr: "Zamanlanmış AI raporları" },
    description: {
      en: "Free-text AI reports emailed on a daily/weekly schedule",
      ar: "تقارير ذكاء نصية تُرسل بالبريد يوميًا/أسبوعيًا",
      tr: "Günlük/haftalık zamanlamayla e-postalanan serbest metin AI raporları",
    },
    icon: "CalendarClock",
    defaultByPlan: BUSINESS_UP,
  },

  // ─── INTEGRATIONS ───
  {
    key: "google_ads",
    category: "integrations",
    label: { en: "Google Ads lead forms", ar: "نماذج عملاء Google Ads", tr: "Google Ads lead formları" },
    description: {
      en: "Capture Google Ads lead-form submissions into the CRM",
      ar: "التقاط نماذج عملاء Google Ads داخل الـ CRM",
      tr: "Google Ads lead formu gönderimlerini CRM'e yakala",
    },
    icon: "Megaphone",
    defaultByPlan: BUSINESS_UP,
  },
  {
    key: "ecommerce_sync",
    category: "integrations",
    label: { en: "E-commerce sync", ar: "مزامنة المتاجر", tr: "E-ticaret senkronizasyonu" },
    description: {
      en: "Sync Shopify / WooCommerce customers, orders and products",
      ar: "مزامنة عملاء وطلبات ومنتجات Shopify / WooCommerce",
      tr: "Shopify / WooCommerce müşteri, sipariş ve ürünlerini senkronize et",
    },
    icon: "ShoppingCart",
    defaultByPlan: STARTER_UP,
  },

  // ─── ADVANCED / ADMIN ───
  {
    key: "custom_branding",
    category: "advanced",
    label: { en: "Custom branding", ar: "هوية مخصصة", tr: "Özel marka" },
    description: {
      en: "Custom logo and brand colors across the workspace",
      ar: "شعار وألوان علامة مخصصة عبر مساحة العمل",
      tr: "Çalışma alanı genelinde özel logo ve marka renkleri",
    },
    icon: "Paintbrush",
    defaultByPlan: BUSINESS_UP,
  },

  // ─── ENTERPRISE (contractual / display — surfaced in the matrix) ───
  {
    key: "sso",
    category: "security",
    label: { en: "SSO (SAML, Okta, Azure AD)", ar: "دخول موحّد (SAML, Okta, Azure AD)", tr: "SSO (SAML, Okta, Azure AD)" },
    description: {
      en: "Single sign-on via SAML / Okta / Azure AD",
      ar: "تسجيل دخول موحّد عبر SAML / Okta / Azure AD",
      tr: "SAML / Okta / Azure AD ile tek oturum açma",
    },
    icon: "KeyRound",
    defaultByPlan: ENTERPRISE_ONLY,
  },
  {
    key: "custom_domain",
    category: "platform",
    label: { en: "Custom domain", ar: "نطاق مخصص", tr: "Özel alan adı" },
    description: {
      en: "Serve the CRM on the customer's own domain",
      ar: "تشغيل الـ CRM على نطاق العميل الخاص",
      tr: "CRM'i müşterinin kendi alan adında sun",
    },
    icon: "Globe",
    defaultByPlan: ENTERPRISE_ONLY,
  },
  {
    key: "white_label",
    category: "platform",
    label: { en: "White-label for resellers", ar: "علامة بيضاء للموزعين", tr: "Bayi için beyaz etiket" },
    description: {
      en: "Remove Zyrix branding for reseller deployments",
      ar: "إزالة علامة Zyrix لعمليات الموزعين",
      tr: "Bayi dağıtımları için Zyrix markasını kaldır",
    },
    icon: "Tag",
    defaultByPlan: ENTERPRISE_ONLY,
  },
  {
    key: "data_residency",
    category: "platform",
    label: { en: "Custom data residency", ar: "موقع بيانات مخصص", tr: "Özel veri lokasyonu" },
    description: {
      en: "Choose data region (KSA, UAE, EU)",
      ar: "اختيار منطقة البيانات (السعودية، الإمارات، الاتحاد الأوروبي)",
      tr: "Veri bölgesini seç (S.Arabistan, BAE, AB)",
    },
    icon: "Database",
    defaultByPlan: ENTERPRISE_ONLY,
  },
  {
    key: "sla",
    category: "platform",
    label: { en: "99.9% uptime SLA", ar: "ضمان جاهزية 99.9%", tr: "%99.9 çalışma süresi SLA" },
    description: {
      en: "Contractual 99.9% uptime guarantee",
      ar: "ضمان تعاقدي بنسبة جاهزية 99.9%",
      tr: "Sözleşmeye dayalı %99.9 çalışma süresi garantisi",
    },
    icon: "ShieldCheck",
    defaultByPlan: ENTERPRISE_ONLY,
  },

  // ════════════════════════════════════════════════════════════════════
  // LIMIT features — numeric caps. defaultByPlan answers "has the capability
  // at all" (limit !== 0); limitByPlan carries the cap (null = unlimited).
  // Values mirror lib/billing/plan-catalog.ts exactly.
  // ════════════════════════════════════════════════════════════════════
  {
    key: "limit_users",
    category: "limits",
    label: { en: "Team members", ar: "أعضاء الفريق", tr: "Ekip üyeleri" },
    description: { en: "Maximum active users", ar: "أقصى عدد للمستخدمين النشطين", tr: "Maksimum aktif kullanıcı" },
    icon: "Users",
    type: "limit",
    defaultByPlan: ALL_ON,
    // Sprint 16R — per-user pricing restructure. User ceilings retuned:
    // Free 2 (hard cap), Starter 20, Business 100, Enterprise unlimited.
    limitByPlan: { free: 2, starter: 20, business: 100, enterprise: null },
  },
  {
    key: "limit_contacts",
    category: "limits",
    label: { en: "Contacts", ar: "جهات الاتصال", tr: "Kişiler" },
    description: { en: "Maximum contacts", ar: "أقصى عدد لجهات الاتصال", tr: "Maksimum kişi" },
    icon: "Contact",
    type: "limit",
    defaultByPlan: ALL_ON,
    limitByPlan: { free: 100, starter: 1000, business: 10000, enterprise: null },
  },
  {
    key: "limit_storage_gb",
    category: "limits",
    label: { en: "File storage (GB)", ar: "تخزين الملفات (جيجابايت)", tr: "Dosya depolama (GB)" },
    description: { en: "Maximum file storage in gigabytes", ar: "أقصى تخزين للملفات بالجيجابايت", tr: "Gigabayt cinsinden maksimum dosya depolama" },
    icon: "HardDrive",
    type: "limit",
    defaultByPlan: ALL_ON,
    limitByPlan: { free: 1, starter: 10, business: 100, enterprise: null },
  },
  {
    key: "limit_whatsapp_msgs_mo",
    category: "limits",
    label: { en: "WhatsApp messages / month", ar: "رسائل واتساب / شهر", tr: "WhatsApp mesajı / ay" },
    description: { en: "Monthly WhatsApp message allowance", ar: "حصة رسائل واتساب الشهرية", tr: "Aylık WhatsApp mesaj kotası" },
    icon: "MessageCircle",
    type: "limit",
    defaultByPlan: ALL_ON,
    limitByPlan: { free: 100, starter: 2000, business: 20000, enterprise: null },
  },
  {
    key: "limit_products",
    category: "limits",
    label: { en: "Products", ar: "المنتجات", tr: "Ürünler" },
    description: { en: "Maximum catalog products", ar: "أقصى عدد لمنتجات الكتالوج", tr: "Maksimum katalog ürünü" },
    icon: "Package",
    type: "limit",
    defaultByPlan: ALL_ON,
    limitByPlan: { free: 25, starter: 500, business: null, enterprise: null },
  },
  {
    key: "limit_ecommerce_stores",
    category: "limits",
    label: { en: "Connected stores", ar: "المتاجر المرتبطة", tr: "Bağlı mağazalar" },
    description: { en: "Maximum connected e-commerce stores", ar: "أقصى عدد للمتاجر الإلكترونية المرتبطة", tr: "Maksimum bağlı e-ticaret mağazası" },
    icon: "Store",
    type: "limit",
    defaultByPlan: STARTER_UP,
    limitByPlan: { free: 0, starter: 1, business: 3, enterprise: null },
  },
  {
    key: "limit_forms",
    category: "limits",
    label: { en: "Forms", ar: "النماذج", tr: "Formlar" },
    description: { en: "Maximum active form flows", ar: "أقصى عدد لتدفقات النماذج النشطة", tr: "Maksimum aktif form akışı" },
    icon: "ClipboardList",
    type: "limit",
    defaultByPlan: STARTER_UP,
    limitByPlan: { free: 0, starter: 3, business: null, enterprise: null },
  },
  {
    key: "limit_active_workflows",
    category: "limits",
    label: { en: "Active workflows", ar: "سير العمل النشط", tr: "Aktif iş akışları" },
    description: { en: "Maximum simultaneously-enabled workflows", ar: "أقصى عدد لسير العمل المفعّل في آن واحد", tr: "Aynı anda etkin maksimum iş akışı" },
    icon: "Workflow",
    type: "limit",
    defaultByPlan: STARTER_UP,
    limitByPlan: { free: 0, starter: 5, business: null, enterprise: null },
  },
  {
    key: "limit_cadences",
    category: "limits",
    label: { en: "Cadences", ar: "التتابعات", tr: "Kadanslar" },
    description: { en: "Maximum active cadences", ar: "أقصى عدد للتتابعات النشطة", tr: "Maksimum aktif kadans" },
    icon: "Repeat",
    type: "limit",
    defaultByPlan: STARTER_UP,
    limitByPlan: { free: 0, starter: 1, business: null, enterprise: null },
  },
];

// ──────────────────────────────────────────────────────────────────────
// Sprint 16 — defaultByPlan RETUNE for pre-existing keys.
// Until this sprint every catalog key shipped ALL_ON (nothing gated by plan)
// so the live tenants kept everything regardless of plan. This map moves the
// premium keys onto their marketing-pricing tiers in ONE auditable place.
//
// ⚠️ LIVE-CUSTOMER SAFETY: the existing gateFeature() middleware already reads
// these defaults, so this retune is itself an enforcement change. It MUST ship
// in the same commit as — and AFTER — the grandfathering pass that writes
// force_on overrides for every feature the 3 live tenants actually use. See
// scripts/s16a-grandfather.ts and entitlements.service.ts.
// ──────────────────────────────────────────────────────────────────────
const PLAN_RETUNE: Record<string, Record<PlanSlug, boolean>> = {
  // Sales — starter and up
  quotes: STARTER_UP,
  quote_esign: STARTER_UP,
  payments_collect: STARTER_UP,
  contracts: STARTER_UP,
  // Growth / comms — starter and up
  email_replies: STARTER_UP,
  email_inbox: STARTER_UP,
  marketing_automation: STARTER_UP,
  // Automation engine — starter gets a capped count (limit_active_workflows)
  ai_workflows: STARTER_UP,
  // AI — business and up
  ai_messaging: BUSINESS_UP,
  ai_agents: BUSINESS_UP,
  ai_cfo: BUSINESS_UP,
  // Advanced — business and up
  multi_brand: BUSINESS_UP,
  analytics_reports: BUSINESS_UP,
  commission: BUSINESS_UP,
};

for (const def of FEATURE_CATALOG) {
  const tuned = PLAN_RETUNE[def.key];
  if (tuned) def.defaultByPlan = tuned;
}

export type FeatureKey = (typeof FEATURE_CATALOG)[number]["key"];

// Fast lookup for the resolver.
const CATALOG_BY_KEY: Map<string, FeatureDefinition> = new Map(
  FEATURE_CATALOG.map((f) => [f.key, f])
);

function isPlanSlug(value: string): value is PlanSlug {
  return value === "free" || value === "starter" || value === "business" || value === "enterprise";
}

// ──────────────────────────────────────────────────────────────────────
// Catalog accessors (Sprint 16) — the entitlements resolver + the
// plan_features seed read the canonical defaults/limits through these so
// there is exactly one definition of each value.
// ──────────────────────────────────────────────────────────────────────

export const ALL_PLANS: PlanSlug[] = ["free", "starter", "business", "enterprise"];

export const LIMIT_KEYS: string[] = FEATURE_CATALOG.filter(
  (f) => f.type === "limit"
).map((f) => f.key);

export function isLimitFeature(key: string): boolean {
  return CATALOG_BY_KEY.get(key)?.type === "limit";
}

export function getCatalogEntry(key: string): FeatureDefinition | undefined {
  return CATALOG_BY_KEY.get(key);
}

/** Plan-default enabled state from the catalog (before any override). */
export function getCatalogDefault(key: string, plan: PlanSlug): boolean {
  return CATALOG_BY_KEY.get(key)?.defaultByPlan[plan] === true;
}

/**
 * Plan-default numeric limit from the catalog. Returns null for unlimited
 * AND for non-limit (boolean) features.
 */
export function getCatalogLimit(key: string, plan: PlanSlug): number | null {
  const def = CATALOG_BY_KEY.get(key);
  if (!def || def.type !== "limit" || !def.limitByPlan) return null;
  return def.limitByPlan[plan];
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
// NOTE (Sprint 16): resolution now lives in entitlements.service (the single
// source of truth — override > legacy JSON > plan_features > catalog). These
// two functions delegate to it so gateFeature() and every existing caller pick
// up per-tenant overrides + the plan retune consistently. The import is lazy to
// avoid a module load-time cycle (entitlements imports this file's catalog).
export async function isFeatureEnabled(
  companyId: string,
  key: string
): Promise<boolean> {
  const { isEnabled } = await import("./entitlements.service");
  return isEnabled(companyId, key);
}

export async function getFullFeatureMap(
  companyId: string
): Promise<Record<string, boolean>> {
  const { booleanMap } = await import("./entitlements.service");
  return booleanMap(companyId);
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
  const { invalidateCompany } = await import("./entitlements.service");
  invalidateCompany(companyId);
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
  const { invalidateCompany } = await import("./entitlements.service");
  invalidateCompany(companyId);
  return getFullFeatureMap(companyId);
}
