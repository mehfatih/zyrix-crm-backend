/**
 * Sprint C-1.B — Pre-flight audit of the 20 blocked migrations.
 * Pure SELECT only against information_schema, pg_constraint,
 * pg_indexes, pg_class, pg_type. No DDL, no transactions, no writes.
 *
 * Classification rules (per C-1.B brief):
 *   GREEN  — every statement is idempotent (IF NOT EXISTS / DO EXCEPTION)
 *   YELLOW — non-idempotent statement(s) exist but their targets are
 *            absent on prod, so first-run succeeds; rerun would fail
 *   RED    — non-idempotent statement targets are already present on
 *            prod; first-run will fail (must patch or resolve --applied)
 *
 * Output is grouped per concern. Operator reads it alongside Section 14
 * of the discovery doc.
 */
import { prisma } from "../src/config/database";

function header(s: string) {
  console.log("\n" + "=".repeat(72));
  console.log(s);
  console.log("=".repeat(72));
}

// ── Inventory of objects each blocked migration would create ──────────
const NEW_TABLES = [
  // 501
  "oauth_states",
  // 502
  "brand_settings",
  // 503
  "notifications", "comments", "mentions",
  // 504
  "scheduled_reports",
  // 505
  "brands",
  // 506
  "tax_invoices",
  // 509
  "session_events",
  // 510
  "roles",
  // 513
  "ip_allowlist",
  // 514
  "retention_policies",
  // 515
  "compliance_tokens",
  // 516
  "scim_tokens",
  // 517
  "network_rules",
  // 518
  "document_links",
  // 519
  "territories", "quotas", "meetings", "contract_signatures", "slack_webhooks",
  // 520
  "doc_events", "doc_article_meta",
];

// (table, column) tuples for ADD COLUMN statements on existing tables
const NEW_COLUMNS: Array<[string, string]> = [
  // 505 — heavy tables
  ["customers", "brandId"],
  ["deals", "brandId"],
  ["activities", "brandId"],
  // 507
  ["companies", "enabledFeatures"],
  // 508
  ["users", "avatarUrl"],
  ["users", "website"],
  ["users", "timezone"],
  ["users", "billingEmail"],
  ["users", "notificationPrefs"],
  // 509
  ["companies", "idleTimeoutMinutes"],
  // 510
  ["users", "customRoleId"],
  // 511 — heavy table
  ["audit_logs", "before"],
  ["audit_logs", "after"],
  ["audit_logs", "sessionId"],
  // 512
  ["companies", "onboardingProgress"],
  // 519 — heavy table
  ["customers", "leadScore"],
  ["customers", "leadScoreUpdatedAt"],
  ["customers", "healthScore"],
  ["customers", "healthScoreUpdatedAt"],
  ["customers", "territory"],
];

// Indexes that the migrations would create on tables that EXIST and
// have user data (so build time is non-trivial and an ACCESS EXCLUSIVE
// write lock is taken without CONCURRENTLY).
const HEAVY_INDEX_TARGETS: Array<{ migration: string; index: string; table: string }> = [
  // 505 — composite on existing entity tables
  { migration: "20260505100000_add_brands", index: "customers_companyId_brandId_idx",  table: "customers"  },
  { migration: "20260505100000_add_brands", index: "deals_companyId_brandId_idx",      table: "deals"      },
  { migration: "20260505100000_add_brands", index: "activities_companyId_brandId_idx", table: "activities" },
  // 510
  { migration: "20260510100000_add_rbac_roles", index: "users_customRoleId_idx", table: "users" },
  // 511
  { migration: "20260511100000_audit_logs_expand", index: "audit_logs_sessionId_idx", table: "audit_logs" },
];

// Bare (non-idempotent) ADD CONSTRAINT statements found in the 20 files.
const BARE_FK_CHECKS: Array<{ migration: string; constraint: string; table: string }> = [
  { migration: "20260503100000_add_collaboration", constraint: "mentions_commentId_fkey", table: "mentions" },
];

async function main() {
  header("(0) Postgres server version");
  const ver = (await prisma.$queryRawUnsafe(
    `SELECT current_setting('server_version_num') AS num,
            current_setting('server_version')      AS pretty`
  )) as Array<{ num: string; pretty: string }>;
  console.log(`  ${ver[0].pretty}  (numeric: ${ver[0].num})`);
  const verNum = parseInt(ver[0].num, 10);
  console.log(`  PG ≥ 11 (instant ADD COLUMN ... DEFAULT, no rewrite): ${verNum >= 110000 ? "YES" : "NO"}`);

  header(`(1) Tables that the 20 migrations would create (${NEW_TABLES.length} expected absent)`);
  const presentTables = (await prisma.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])
     ORDER BY table_name`,
    NEW_TABLES
  )) as Array<{ table_name: string }>;
  const presentTableSet = new Set(presentTables.map((r) => r.table_name));
  for (const t of NEW_TABLES) {
    console.log(`  ${t.padEnd(24)} -> ${presentTableSet.has(t) ? "ALREADY PRESENT (!)" : "absent (expected)"}`);
  }
  console.log(`  summary: ${presentTables.length}/${NEW_TABLES.length} unexpectedly present`);

  header(`(2) Columns the 20 migrations would add (${NEW_COLUMNS.length} expected absent)`);
  const colKeys = NEW_COLUMNS.map(([t, c]) => `${t}.${c}`);
  const presentCols = (await prisma.$queryRawUnsafe(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (table_name || '.' || column_name) = ANY($1::text[])
     ORDER BY table_name, column_name`,
    colKeys
  )) as Array<{ table_name: string; column_name: string }>;
  const presentColSet = new Set(presentCols.map((r) => `${r.table_name}.${r.column_name}`));
  for (const [t, c] of NEW_COLUMNS) {
    const k = `${t}.${c}`;
    console.log(`  ${k.padEnd(34)} -> ${presentColSet.has(k) ? "ALREADY PRESENT (!)" : "absent (expected)"}`);
  }
  console.log(`  summary: ${presentCols.length}/${NEW_COLUMNS.length} unexpectedly present`);

  header(`(3) Bare-FK ADD CONSTRAINT existence check (${BARE_FK_CHECKS.length} statement(s))`);
  for (const fk of BARE_FK_CHECKS) {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT 1 FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       WHERE c.conname = $1 AND t.relname = $2 LIMIT 1`,
      fk.constraint, fk.table
    )) as Array<{ "?column?": number }>;
    const present = rows.length > 0;
    console.log(`  ${fk.migration}`);
    console.log(`    constraint ${fk.constraint} on ${fk.table}: ${present ? "ALREADY PRESENT — RED" : "absent — first-run safe (YELLOW)"}`);
  }

  header(`(4) Heavy-table CREATE INDEX targets — existence + table size estimates`);
  for (const ix of HEAVY_INDEX_TARGETS) {
    const ixRows = (await prisma.$queryRawUnsafe(
      `SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
                                  AND indexname = $1 LIMIT 1`,
      ix.index
    )) as Array<{ "?column?": number }>;
    const ixPresent = ixRows.length > 0;

    const sizeRows = (await prisma.$queryRawUnsafe(
      `SELECT c.reltuples::bigint AS est_rows,
              pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = $1`,
      ix.table
    )) as Array<{ est_rows: bigint; total_size: string }>;
    const est = sizeRows[0];

    console.log(`  ${ix.migration}`);
    console.log(`    index ${ix.index} on ${ix.table}`);
    console.log(`      already present: ${ixPresent ? "YES (would skip — but bare CREATE w/o IF NOT EXISTS would fail!)" : "no — will be built on first run"}`);
    if (est) {
      console.log(`      table size:      est ${est.est_rows} rows, ${est.total_size} total`);
    } else {
      console.log(`      table size:      table not present`);
    }
  }

  header("(5) Sanity: any unexpected partial state on _prisma_migrations?");
  const dbRows = (await prisma.$queryRawUnsafe(
    `SELECT migration_name, finished_at IS NOT NULL AS applied, rolled_back_at IS NOT NULL AS rolled_back
     FROM _prisma_migrations
     WHERE migration_name = ANY($1::text[])`,
    [
      "20260501100000_add_oauth_states",
      "20260502100000_add_brand_settings",
      "20260503100000_add_collaboration",
      "20260504100000_add_scheduled_reports",
      "20260505100000_add_brands",
      "20260506100000_add_tax_invoices",
      "20260507100000_add_enabled_features",
      "20260508100000_add_user_profile_fields",
      "20260509100000_add_session_events",
      "20260510100000_add_rbac_roles",
      "20260511100000_audit_logs_expand",
      "20260512100000_onboarding_progress",
      "20260513100000_ip_allowlist",
      "20260514100000_retention_policies",
      "20260515100000_compliance_tokens",
      "20260516100000_scim_tokens",
      "20260517100000_network_rules",
      "20260518100000_document_links",
      "20260519100000_bonus_b1_b10",
      "20260520100000_docs_sprint",
    ]
  )) as Array<{ migration_name: string; applied: boolean; rolled_back: boolean }>;
  if (dbRows.length === 0) {
    console.log("  (no rows — confirms all 20 are absent from _prisma_migrations as expected)");
  } else {
    for (const r of dbRows) {
      console.log(`  UNEXPECTED: ${r.migration_name}  applied=${r.applied}  rolled_back=${r.rolled_back}`);
    }
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    return prisma.$disconnect().then(() => process.exit(1));
  });
