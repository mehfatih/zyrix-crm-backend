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
// keys to booleans. Missing keys default to ENABLED so we don't need
// a data migration every time we add a feature.
// ============================================================================

import { prisma } from "../config/database";
import { badRequest, notFound } from "../middleware/errorHandler";

// ──────────────────────────────────────────────────────────────────────
// The canonical list of gate-able features. Keep this in sync with
// the admin UI — the admin page renders toggles for each entry here.
// ──────────────────────────────────────────────────────────────────────

export const FEATURE_CATALOG = [
  {
    key: "quotes",
    label: { en: "Quotes", ar: "عروض الأسعار", tr: "Teklifler" },
    description: {
      en: "Create and send price quotes",
      ar: "إنشاء وإرسال عروض الأسعار",
      tr: "Fiyat teklifleri oluştur ve gönder",
    },
    category: "sales",
  },
  {
    key: "contracts",
    label: { en: "Contracts", ar: "العقود", tr: "Sözleşmeler" },
    description: {
      en: "Contract management + e-signature",
      ar: "إدارة العقود + التوقيع الإلكتروني",
      tr: "Sözleşme yönetimi + e-imza",
    },
    category: "sales",
  },
  {
    key: "loyalty",
    label: { en: "Loyalty", ar: "برنامج الولاء", tr: "Sadakat" },
    description: {
      en: "Points + tiers + rewards program",
      ar: "برنامج النقاط + المستويات + المكافآت",
      tr: "Puan + seviye + ödül programı",
    },
    category: "growth",
  },
  {
    key: "ai_cfo",
    label: { en: "AI CFO", ar: "الذكاء الاصطناعي المالي", tr: "AI CFO" },
    description: {
      en: "AI-powered financial dashboard + insights",
      ar: "لوحة مالية مدعومة بالذكاء الاصطناعي",
      tr: "Yapay zeka destekli finansal panel",
    },
    category: "ai",
  },
  {
    key: "marketing_automation",
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
    category: "growth",
  },
  {
    key: "customer_portal",
    label: { en: "Customer portal", ar: "بوابة العميل", tr: "Müşteri portalı" },
    description: {
      en: "Self-service customer dashboard",
      ar: "لوحة تحكم ذاتية الخدمة للعميل",
      tr: "Self-servis müşteri paneli",
    },
    category: "ops",
  },
  {
    key: "tax_invoices",
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
    category: "compliance",
  },
  {
    key: "multi_brand",
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
    category: "advanced",
  },
  {
    key: "analytics_reports",
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
    category: "advanced",
  },
  {
    key: "payments",
    label: { en: "Payments", ar: "المدفوعات", tr: "Ödemeler" },
    description: {
      en: "Payment links + Stripe + local gateways",
      ar: "روابط الدفع + Stripe + بوابات محلية",
      tr: "Ödeme bağlantıları + Stripe + yerel ağ geçitleri",
    },
    category: "ops",
  },
  {
    key: "commission",
    label: { en: "Commission", ar: "العمولات", tr: "Komisyon" },
    description: {
      en: "Sales team commission tracking",
      ar: "تتبع عمولات فريق المبيعات",
      tr: "Satış ekibi komisyon takibi",
    },
    category: "sales",
  },
  {
    key: "team_collaboration",
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
    category: "ops",
  },
];

export type FeatureKey = (typeof FEATURE_CATALOG)[number]["key"];

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

/**
 * Resolve a feature's enabled state, filling in the default (ENABLED).
 * Used by the feature-gate middleware AND by the frontend (so the
 * UI can hide/grey-out disabled items).
 */
export async function isFeatureEnabled(
  companyId: string,
  key: string
): Promise<boolean> {
  const flags = await getEnabledFeatures(companyId);
  if (key in flags) return flags[key] === true;
  return true; // default: enabled
}

export async function getFullFeatureMap(
  companyId: string
): Promise<Record<string, boolean>> {
  const overrides = await getEnabledFeatures(companyId);
  const full: Record<string, boolean> = {};
  for (const def of FEATURE_CATALOG) {
    full[def.key] = def.key in overrides ? overrides[def.key] === true : true;
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
  // Validate every incoming key
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
