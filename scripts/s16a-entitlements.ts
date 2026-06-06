// ============================================================================
// SPRINT 16A — Entitlement seed + grandfathering
// ----------------------------------------------------------------------------
// Modes (argv[2]):
//   report  (default) — READ-ONLY. Prints, per active tenant: current plan,
//                       usage counts, the force_on overrides that WOULD be
//                       written to guarantee zero feature loss, and a
//                       recommended plan. Touches nothing.
//   seed              — Upserts plan_features (4 plans × catalog) from the
//                       canonical catalog (idempotent). Requires the migration
//                       tables to exist.
//   apply  --confirm  — Runs seed, THEN writes the grandfathering force_on
//                       overrides (zero-loss freeze of each tenant's current
//                       access). Does NOT change company.plan (Mehmet adjusts
//                       plans manually from the admin matrix afterwards).
//
// Run:  npx tsx scripts/s16a-entitlements.ts            (report)
//       npx tsx scripts/s16a-entitlements.ts seed
//       npx tsx scripts/s16a-entitlements.ts apply --confirm
//
// SAFETY: report mode is the mini-STOP deliverable. Nothing is applied to prod
// until Mehmet reviews the report and approves. DATABASE_URL points at the
// Railway prod proxy (per the locked rules), so SELECTs here read live data.
// ============================================================================
import "dotenv/config";
import { randomUUID } from "crypto";
import { prisma } from "../src/config/database";
import {
  FEATURE_CATALOG,
  ALL_PLANS,
  isLimitFeature,
  getCatalogLimit,
  type PlanSlug,
} from "../src/services/feature-flags.service";

type Counts = Record<string, number>;

const MODE = (process.argv[2] || "report").toLowerCase();
const CONFIRM = process.argv.includes("--confirm");
const RANK: Record<PlanSlug, number> = { free: 0, starter: 1, business: 2, enterprise: 3 };

function asPlan(v: string | null | undefined): PlanSlug {
  return v && (ALL_PLANS as string[]).includes(v) ? (v as PlanSlug) : "free";
}

// ── OLD effective default (pre-Sprint-16) per key, per plan ──────────────
// Used to decide which keys were ON for a tenant before the retune so we only
// force_on what would actually be LOST (never spuriously). For the keys the
// sprint retuned (and the new keys that map to surfaces that were UNGATED and
// thus effectively on for everyone), old = ALL_ON. ai_workflows / its limit
// were gated BUSINESS_UP before. Everything else used its new default.
const ALL_ON = { free: true, starter: true, business: true, enterprise: true };
const BUSINESS_UP = { free: false, starter: false, business: true, enterprise: true };

const OLD_EFFECTIVE: Record<string, Record<PlanSlug, boolean>> = {
  // retuned existing keys (were ALL_ON)
  quotes: ALL_ON, quote_esign: ALL_ON, payments_collect: ALL_ON, contracts: ALL_ON,
  email_replies: ALL_ON, email_inbox: ALL_ON, marketing_automation: ALL_ON,
  ai_messaging: ALL_ON, ai_agents: ALL_ON, ai_cfo: ALL_ON,
  multi_brand: ALL_ON, analytics_reports: ALL_ON, commission: ALL_ON,
  // new keys mapping to previously-ungated (effectively-on) surfaces
  price_books: ALL_ON, discount_approvals: ALL_ON, email_tracking: ALL_ON,
  forms: ALL_ON, custom_actions: ALL_ON, ai_studio: ALL_ON,
  scheduled_ai_reports: ALL_ON, google_ads: ALL_ON, ecommerce_sync: ALL_ON,
  custom_branding: ALL_ON,
  // limit keys whose surfaces were effectively on before
  limit_forms: ALL_ON, limit_ecommerce_stores: ALL_ON, limit_cadences: ALL_ON,
  // workflows engine was BUSINESS_UP before
  ai_workflows: BUSINESS_UP, limit_active_workflows: BUSINESS_UP,
};

function oldDefault(key: string, plan: PlanSlug): boolean {
  const m = OLD_EFFECTIVE[key];
  if (m) return m[plan];
  // fall back to the (current) catalog default → no change → never force_on
  const def = FEATURE_CATALOG.find((f) => f.key === key);
  return def ? def.defaultByPlan[plan] === true : true;
}
function newDefault(key: string, plan: PlanSlug): boolean {
  const def = FEATURE_CATALOG.find((f) => f.key === key);
  return def ? def.defaultByPlan[plan] === true : true;
}

// ── Usage detection (data presence) ──────────────────────────────────────
async function safeCount(sql: string, id: string): Promise<number> {
  try {
    const rows = (await prisma.$queryRawUnsafe(sql, id)) as Array<{ c: bigint | number }>;
    return Number(rows[0]?.c ?? 0);
  } catch {
    return -1; // table missing / query failed → unknown
  }
}

async function countsFor(companyId: string): Promise<Counts> {
  const q = (t: string, extra = "") =>
    `SELECT count(*)::int AS c FROM "${t}" WHERE "companyId" = $1 ${extra}`;
  const [
    users, customers, deals, quotes, contracts, products, stores, forms,
    activeWorkflows, activeCadences, whatsappChats, conversations, loyalty,
    territories, customRoles, brands, taxInvoices, savedAiReports, aiProfiles,
    actionRecipes, emailMessages, paymentConnections, emailInbox,
  ] = await Promise.all([
    safeCount(q("users"), companyId),
    safeCount(q("customers", `AND "deletedAt" IS NULL`), companyId),
    safeCount(q("deals"), companyId),
    safeCount(q("quotes"), companyId),
    safeCount(q("contracts"), companyId),
    safeCount(q("products"), companyId),
    safeCount(q("ecommerce_stores"), companyId),
    safeCount(q("form_flows"), companyId),
    safeCount(q("workflows", `AND "isEnabled" = true`), companyId),
    safeCount(q("cadences", `AND "status" = 'active'`), companyId),
    safeCount(q("whatsapp_chats"), companyId),
    safeCount(q("conversations"), companyId),
    safeCount(q("loyalty_transactions"), companyId),
    safeCount(q("territories"), companyId),
    safeCount(q("roles", `AND "isSystem" = false`), companyId),
    safeCount(q("brands"), companyId),
    safeCount(q("tax_invoices"), companyId),
    safeCount(q("saved_ai_reports"), companyId),
    safeCount(q("company_ai_profiles"), companyId),
    safeCount(q("action_recipes"), companyId),
    safeCount(q("email_messages"), companyId),
    safeCount(q("payment_connections"), companyId),
    safeCount(q("email_inbox_connections"), companyId),
  ]);
  return {
    users, customers, deals, quotes, contracts, products, stores, forms,
    activeWorkflows, activeCadences, whatsappChats, conversations, loyalty,
    territories, customRoles, brands, taxInvoices, savedAiReports, aiProfiles,
    actionRecipes, emailMessages, paymentConnections, emailInbox,
  };
}

// feature key → did this tenant leave data for it? (true/false/undefined=n/a)
function usesData(key: string, c: Counts): boolean | undefined {
  const has = (n: number) => n > 0;
  switch (key) {
    case "quotes": case "quote_esign": case "price_books": case "discount_approvals":
      return has(c.quotes);
    case "contracts": return has(c.contracts);
    case "marketing_automation": return has(c.activeWorkflows) || has(c.activeCadences);
    case "ai_workflows": case "limit_active_workflows": return has(c.activeWorkflows);
    case "limit_cadences": return has(c.activeCadences);
    case "multi_brand": return c.brands > 1;
    case "email_replies": case "email_tracking": return has(c.emailMessages);
    case "email_inbox": return has(c.emailInbox);
    case "payments_collect": return has(c.paymentConnections);
    case "forms": case "limit_forms": return has(c.forms);
    case "ecommerce_sync": case "limit_ecommerce_stores": return has(c.stores);
    case "commission": return has(c.territories) ? undefined : undefined; // no table → n/a
    case "ai_studio": return has(c.aiProfiles);
    case "scheduled_ai_reports": case "ai_cfo": case "analytics_reports":
      return has(c.savedAiReports);
    case "custom_actions": return has(c.actionRecipes);
    case "ai_messaging": case "ai_agents": return undefined; // no reliable table
    default: return undefined;
  }
}

// Keys eligible for grandfathering = anything where old=ON & could become OFF
// for some plan. (Stable across tenants; per-tenant we test their plan.)
const GRANDFATHER_KEYS = FEATURE_CATALOG.map((f) => f.key).filter((k) =>
  (ALL_PLANS as PlanSlug[]).some((p) => oldDefault(k, p) && !newDefault(k, p))
);

function forceOnSetFor(plan: PlanSlug, legacy: Record<string, boolean>): string[] {
  return GRANDFATHER_KEYS.filter(
    (k) => oldDefault(k, plan) && !newDefault(k, plan) && legacy[k] !== false
  );
}

function recommendPlan(c: Counts): PlanSlug {
  // smallest tier whose NEW defaults enable every feature the tenant has data
  // for AND whose limits cover current usage.
  const usedKeys = FEATURE_CATALOG.map((f) => f.key).filter((k) => usesData(k, c) === true);
  const usageFor = (k: string): number => {
    switch (k) {
      case "limit_users": return c.users;
      case "limit_contacts": return c.customers;
      case "limit_products": return c.products;
      case "limit_forms": return c.forms;
      case "limit_ecommerce_stores": return c.stores;
      case "limit_active_workflows": return c.activeWorkflows;
      case "limit_cadences": return c.activeCadences;
      default: return 0;
    }
  };
  for (const p of ["free", "starter", "business", "enterprise"] as PlanSlug[]) {
    const featuresOk = usedKeys.every((k) => newDefault(k, p));
    const limitsOk = FEATURE_CATALOG.filter((f) => isLimitFeature(f.key)).every((f) => {
      const lim = getCatalogLimit(f.key, p);
      return lim === null || usageFor(f.key) <= lim;
    });
    if (featuresOk && limitsOk) return p;
  }
  return "enterprise";
}

// ── plan_features seed (from catalog) ────────────────────────────────────
async function seedPlanFeatures(): Promise<number> {
  let n = 0;
  for (const plan of ALL_PLANS as PlanSlug[]) {
    for (const def of FEATURE_CATALOG) {
      const enabled = def.defaultByPlan[plan] === true;
      const limit =
        def.type === "limit" && def.limitByPlan ? def.limitByPlan[plan] : null;
      await prisma.$executeRawUnsafe(
        `INSERT INTO plan_features ("id","plan","featureKey","enabled","limitValue","updatedAt","createdAt")
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         ON CONFLICT ("plan","featureKey")
         DO UPDATE SET "enabled" = EXCLUDED."enabled",
                       "limitValue" = EXCLUDED."limitValue",
                       "updatedAt" = NOW()`,
        randomUUID(), plan, def.key, enabled, limit
      );
      n++;
    }
  }
  return n;
}

async function writeForceOn(companyId: string, keys: string[]): Promise<void> {
  for (const k of keys) {
    const limitOverride = isLimitFeature(k) ? null : null; // null = unlimited / n/a
    await prisma.$executeRawUnsafe(
      `INSERT INTO company_feature_overrides
         ("id","companyId","featureKey","mode","limitOverride","updatedBy","createdAt","updatedAt")
       VALUES ($1, $2, $3, 'force_on', $4, 'grandfather-s16a', NOW(), NOW())
       ON CONFLICT ("companyId","featureKey")
       DO UPDATE SET "mode" = 'force_on', "updatedAt" = NOW()`,
      randomUUID(), companyId, k, limitOverride
    );
  }
}

async function main() {
  console.log(`\n=== Sprint 16A entitlements — mode: ${MODE} ===\n`);
  console.log(`Grandfather-eligible keys (old ON → new OFF on some plan): ${GRANDFATHER_KEYS.length}`);
  console.log(GRANDFATHER_KEYS.join(", ") + "\n");

  if (MODE === "seed" || MODE === "apply") {
    if (MODE === "apply" && !CONFIRM) {
      console.error("Refusing to apply without --confirm.");
      process.exit(1);
    }
    const seeded = await seedPlanFeatures();
    console.log(`plan_features seeded/updated: ${seeded} rows (4 plans × ${FEATURE_CATALOG.length} keys).\n`);
    if (MODE === "seed") { await prisma.$disconnect(); return; }
  }

  // Active companies (skip soft-deleted). Report covers all; we flag "empty" shells.
  const companies = (await prisma.$queryRawUnsafe(
    `SELECT id, name, plan, status, "enabledFeatures"
       FROM companies WHERE "deletedAt" IS NULL ORDER BY "createdAt" ASC`
  )) as Array<{ id: string; name: string; plan: string | null; status: string; enabledFeatures: unknown }>;

  console.log(`Companies (not deleted): ${companies.length}\n`);

  let applied = 0;
  for (const co of companies) {
    const plan = asPlan(co.plan);
    const legacy =
      co.enabledFeatures && typeof co.enabledFeatures === "object" && !Array.isArray(co.enabledFeatures)
        ? (co.enabledFeatures as Record<string, boolean>)
        : {};
    const c = await countsFor(co.id);
    const isEmpty = c.users <= 1 && c.customers <= 0 && c.deals <= 0;
    const forceOn = forceOnSetFor(plan, legacy);
    const rec = recommendPlan(c);

    console.log("────────────────────────────────────────────────────────");
    console.log(`${co.name}  [${co.id}]`);
    console.log(`  status=${co.status}  plan=${plan}  ${isEmpty ? "⚠️ EMPTY/throwaway shell" : ""}`);
    console.log(
      `  usage: users=${c.users} contacts=${c.customers} deals=${c.deals} quotes=${c.quotes} ` +
      `contracts=${c.contracts} products=${c.products} stores=${c.stores} forms=${c.forms} ` +
      `wf(active)=${c.activeWorkflows} cadences(active)=${c.activeCadences} wa=${c.whatsappChats} ` +
      `conv=${c.conversations} loyalty=${c.loyalty} brands=${c.brands} roles(custom)=${c.customRoles} ` +
      `tax=${c.taxInvoices} email=${c.emailMessages} inbox=${c.emailInbox} pay=${c.paymentConnections} ` +
      `aiProfiles=${c.aiProfiles} savedReports=${c.savedAiReports} recipes=${c.actionRecipes}`
    );
    console.log(`  → recommended plan: ${rec}${RANK[rec] > RANK[plan] ? "  (upgrade suggested)" : ""}`);
    if (forceOn.length === 0) {
      console.log(`  → force_on overrides: none (current plan already covers everything)`);
    } else {
      const annotated = forceOn.map((k) => {
        const u = usesData(k, c);
        return `${k}${u === true ? "*" : u === false ? "" : "?"}`;
      });
      console.log(`  → force_on overrides (${forceOn.length}) [* = has data, ? = n/a]:`);
      console.log(`      ${annotated.join(", ")}`);
    }

    if (MODE === "apply") {
      // Grandfather only NON-empty active tenants. Empty shells get nothing.
      if (!isEmpty && co.status === "active" && forceOn.length > 0) {
        await writeForceOn(co.id, forceOn);
        applied++;
      }
    }
  }

  if (MODE === "apply") {
    console.log(`\nApplied force_on overrides to ${applied} tenant(s).`);
    try {
      const { invalidateAll } = await import("../src/services/entitlements.service");
      invalidateAll();
    } catch {}
  } else {
    console.log(`\n(REPORT ONLY — nothing written. Run 'apply --confirm' after approval.)`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
