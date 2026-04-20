import { prisma } from "../config/database";
import { hashPassword } from "../utils/password";
import { env } from "../config/env";
import { badRequest, conflict } from "../middleware/errorHandler";

// ============================================================================
// ADMIN BOOTSTRAP SERVICE
// ============================================================================
// Runs once on fresh DB to create:
//   - Shadow Company ("Zyrix System") for super admins
//   - 2 super admins (from SUPER_ADMIN_EMAILS env)
//   - 4 Plans (Free, Starter, Business, Enterprise)
//
// Idempotency:
//   - If any super_admin already exists, refuses to run.
//   - Requires ADMIN_BOOTSTRAP_TOKEN to match env value.
// ============================================================================

// ─────────────────────────────────────────────────────────────────────────
// Plan Feature Catalog (reference — consumed by Plan.features JSON)
// ─────────────────────────────────────────────────────────────────────────
export const ALL_FEATURES = {
  // Basic CRM
  contacts: "contacts",
  deals: "deals",
  pipeline: "pipeline",
  tasks: "tasks",
  notes: "notes",

  // Communication
  whatsapp_basic: "whatsapp_basic",
  whatsapp_api: "whatsapp_api",
  email_sync: "email_sync",
  live_chat: "live_chat",

  // AI
  ai_extract: "ai_extract",
  ai_cfo: "ai_cfo",
  ai_insights: "ai_insights",
  ai_dialects: "ai_dialects",
  ai_voice: "ai_voice",

  // Sales
  quotes: "quotes",
  invoices: "invoices",
  commission: "commission",
  loyalty: "loyalty",

  // Analytics
  dashboards: "dashboards",
  forecasts: "forecasts",
  reports_advanced: "reports_advanced",

  // Automation
  workflows_basic: "workflows_basic",
  workflows_advanced: "workflows_advanced",

  // Support
  customer_portal: "customer_portal",
  tickets: "tickets",

  // Enterprise
  sso: "sso",
  audit_log: "audit_log",
  white_label: "white_label",
  dedicated_support: "dedicated_support",
  custom_domain: "custom_domain",
  api_access: "api_access",
} as const;

// ─────────────────────────────────────────────────────────────────────────
// Plan Seed Data
// ─────────────────────────────────────────────────────────────────────────
const PLANS_SEED = [
  {
    slug: "free",
    name: "Free",
    nameAr: "مجاني",
    nameTr: "Ücretsiz",
    description: "Perfect for solo founders starting out",
    descriptionAr: "مثالي للمؤسسين الأفراد في بداياتهم",
    descriptionTr: "Yeni başlayan kurucular için mükemmel",
    priceMonthlyUsd: 0,
    priceYearlyUsd: 0,
    priceMonthlyTry: 0,
    priceYearlyTry: 0,
    priceMonthlySar: 0,
    priceYearlySar: 0,
    maxUsers: 3,
    maxCustomers: 100,
    maxDeals: 100,
    maxStorageGb: 1,
    maxWhatsappMsg: 100,
    maxAiTokens: 10000,
    features: [
      ALL_FEATURES.contacts,
      ALL_FEATURES.deals,
      ALL_FEATURES.pipeline,
      ALL_FEATURES.tasks,
      ALL_FEATURES.notes,
      ALL_FEATURES.whatsapp_basic,
      ALL_FEATURES.dashboards,
    ],
    isActive: true,
    isFeatured: false,
    sortOrder: 1,
    color: "#64748B",
  },
  {
    slug: "starter",
    name: "Starter",
    nameAr: "المبتدئ",
    nameTr: "Başlangıç",
    description: "For small teams ready to grow",
    descriptionAr: "للفرق الصغيرة المستعدة للنمو",
    descriptionTr: "Büyümeye hazır küçük ekipler için",
    priceMonthlyUsd: 19,
    priceYearlyUsd: 190,
    priceMonthlyTry: 699,
    priceYearlyTry: 6990,
    priceMonthlySar: 71,
    priceYearlySar: 710,
    maxUsers: 10,
    maxCustomers: 1000,
    maxDeals: 1000,
    maxStorageGb: 10,
    maxWhatsappMsg: 2000,
    maxAiTokens: 100000,
    features: [
      ALL_FEATURES.contacts,
      ALL_FEATURES.deals,
      ALL_FEATURES.pipeline,
      ALL_FEATURES.tasks,
      ALL_FEATURES.notes,
      ALL_FEATURES.whatsapp_basic,
      ALL_FEATURES.whatsapp_api,
      ALL_FEATURES.email_sync,
      ALL_FEATURES.live_chat,
      ALL_FEATURES.ai_extract,
      ALL_FEATURES.quotes,
      ALL_FEATURES.invoices,
      ALL_FEATURES.dashboards,
      ALL_FEATURES.workflows_basic,
      ALL_FEATURES.customer_portal,
    ],
    isActive: true,
    isFeatured: false,
    sortOrder: 2,
    color: "#0891B2",
  },
  {
    slug: "business",
    name: "Business",
    nameAr: "الأعمال",
    nameTr: "İşletme",
    description: "Everything teams need to scale",
    descriptionAr: "كل ما تحتاجه الفرق للتوسع",
    descriptionTr: "Ekiplerin büyümek için ihtiyacı olan her şey",
    priceMonthlyUsd: 49,
    priceYearlyUsd: 490,
    priceMonthlyTry: 1799,
    priceYearlyTry: 17990,
    priceMonthlySar: 184,
    priceYearlySar: 1840,
    maxUsers: 50,
    maxCustomers: 10000,
    maxDeals: 10000,
    maxStorageGb: 100,
    maxWhatsappMsg: 20000,
    maxAiTokens: 1000000,
    features: [
      ALL_FEATURES.contacts,
      ALL_FEATURES.deals,
      ALL_FEATURES.pipeline,
      ALL_FEATURES.tasks,
      ALL_FEATURES.notes,
      ALL_FEATURES.whatsapp_basic,
      ALL_FEATURES.whatsapp_api,
      ALL_FEATURES.email_sync,
      ALL_FEATURES.live_chat,
      ALL_FEATURES.ai_extract,
      ALL_FEATURES.ai_cfo,
      ALL_FEATURES.ai_insights,
      ALL_FEATURES.ai_dialects,
      ALL_FEATURES.quotes,
      ALL_FEATURES.invoices,
      ALL_FEATURES.commission,
      ALL_FEATURES.loyalty,
      ALL_FEATURES.dashboards,
      ALL_FEATURES.forecasts,
      ALL_FEATURES.reports_advanced,
      ALL_FEATURES.workflows_basic,
      ALL_FEATURES.workflows_advanced,
      ALL_FEATURES.customer_portal,
      ALL_FEATURES.tickets,
      ALL_FEATURES.audit_log,
      ALL_FEATURES.api_access,
    ],
    isActive: true,
    isFeatured: true,
    sortOrder: 3,
    color: "#0E7490",
  },
  {
    slug: "enterprise",
    name: "Enterprise",
    nameAr: "المؤسسات",
    nameTr: "Kurumsal",
    description: "Custom solutions for large organizations",
    descriptionAr: "حلول مخصصة للمؤسسات الكبرى",
    descriptionTr: "Büyük kuruluşlar için özel çözümler",
    priceMonthlyUsd: 0,
    priceYearlyUsd: 0,
    priceMonthlyTry: 0,
    priceYearlyTry: 0,
    priceMonthlySar: 0,
    priceYearlySar: 0,
    maxUsers: 999999,
    maxCustomers: 9999999,
    maxDeals: 9999999,
    maxStorageGb: 9999,
    maxWhatsappMsg: 9999999,
    maxAiTokens: 999999999,
    features: Object.values(ALL_FEATURES),
    isActive: true,
    isFeatured: false,
    sortOrder: 4,
    color: "#164E63",
  },
];

// ─────────────────────────────────────────────────────────────────────────
// Bootstrap Admin Panel
// ─────────────────────────────────────────────────────────────────────────
export interface BootstrapResult {
  shadowCompany: { id: string; name: string; slug: string };
  superAdmins: Array<{ id: string; email: string; fullName: string }>;
  plans: Array<{ id: string; slug: string; name: string }>;
}

export async function bootstrapAdminPanel(
  providedToken: string
): Promise<BootstrapResult> {
  // 1. Verify bootstrap token
  if (!env.ADMIN_BOOTSTRAP_TOKEN) {
    throw badRequest(
      "ADMIN_BOOTSTRAP_TOKEN is not configured in server environment"
    );
  }

  if (providedToken !== env.ADMIN_BOOTSTRAP_TOKEN) {
    throw badRequest("Invalid bootstrap token");
  }

  // 2. Check if already bootstrapped (any super_admin exists)
  const existingSuperAdmin = await prisma.user.findFirst({
    where: { role: "super_admin" },
  });

  if (existingSuperAdmin) {
    throw conflict(
      "Admin panel already bootstrapped — super admin(s) exist. Use /api/admin/login instead."
    );
  }

  // 3. Parse required env config
  if (!env.SUPER_ADMIN_EMAILS) {
    throw badRequest("SUPER_ADMIN_EMAILS is not configured");
  }
  if (!env.SUPER_ADMIN_PASSWORD) {
    throw badRequest("SUPER_ADMIN_PASSWORD is not configured");
  }

  const emails = env.SUPER_ADMIN_EMAILS.split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);

  if (emails.length === 0) {
    throw badRequest("SUPER_ADMIN_EMAILS contains no valid emails");
  }

  // 4. Create/find Shadow Company + 2 Super Admins + 4 Plans in a single transaction
  const passwordHash = await hashPassword(env.SUPER_ADMIN_PASSWORD);

  const result = await prisma.$transaction(async (tx) => {
    // Shadow Company
    let shadow = await tx.company.findUnique({
      where: { slug: "zyrix-system" },
    });
    if (!shadow) {
      shadow = await tx.company.create({
        data: {
          name: "Zyrix System",
          slug: "zyrix-system",
          plan: "enterprise",
          status: "active",
        },
      });
    }

    // Super Admins
    const superAdmins = [];
    for (const email of emails) {
      // Skip if user with this email already exists (shouldn't happen but safe)
      const existing = await tx.user.findUnique({ where: { email } });
      if (existing) {
        // Promote to super_admin if not already
        if (existing.role !== "super_admin") {
          const promoted = await tx.user.update({
            where: { id: existing.id },
            data: {
              role: "super_admin",
              passwordHash,
              emailVerified: true,
              status: "active",
            },
          });
          superAdmins.push(promoted);
        } else {
          superAdmins.push(existing);
        }
        continue;
      }

      const created = await tx.user.create({
        data: {
          companyId: shadow.id,
          email,
          fullName: email.split("@")[0],
          passwordHash,
          role: "super_admin",
          emailVerified: true,
          status: "active",
        },
      });
      superAdmins.push(created);
    }

    // Plans
    const plans = [];
    for (const planData of PLANS_SEED) {
      const existing = await tx.plan.findUnique({
        where: { slug: planData.slug },
      });
      if (existing) {
        plans.push(existing);
        continue;
      }
      const created = await tx.plan.create({
        data: planData,
      });
      plans.push(created);
    }

    return { shadow, superAdmins, plans };
  });

  // 5. Log bootstrap action to audit log (outside txn — non-critical)
  try {
    await prisma.auditLog.create({
      data: {
        action: "admin.bootstrap",
        entityType: "system",
        metadata: {
          superAdminCount: result.superAdmins.length,
          planCount: result.plans.length,
          shadowCompanyId: result.shadow.id,
        },
      },
    });
  } catch {
    // Non-critical
  }

  return {
    shadowCompany: {
      id: result.shadow.id,
      name: result.shadow.name,
      slug: result.shadow.slug,
    },
    superAdmins: result.superAdmins.map((u) => ({
      id: u.id,
      email: u.email,
      fullName: u.fullName,
    })),
    plans: result.plans.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
    })),
  };
}
