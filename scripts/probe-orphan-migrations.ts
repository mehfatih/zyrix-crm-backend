/**
 * Sprint C-1.A — Orphan migrations probe (READ-ONLY).
 * Classifies every statement in the two orphan migrations:
 *   - 20260420150924_add_admin_panel_schema   (the older bare-DDL version,
 *     shadowed by 20260420160000 which did apply)
 *   - 20260422100000_password_reset_tokens
 * Pure SELECT against information_schema / pg_constraint / pg_indexes.
 * No DDL, no transactions, no writes.
 */
import { prisma } from "../src/config/database";

function header(s: string) {
  console.log("\n" + "=".repeat(72));
  console.log(s);
  console.log("=".repeat(72));
}

async function main() {
  // ─────────────────────────────────────────────────────────────────
  // 20260420150924 / 20260420160000  — admin panel schema
  // Both files create the same set of objects.  We probe ONCE; the
  // results apply to both orphans because they have the same target
  // schema.
  // ─────────────────────────────────────────────────────────────────
  header("(A) admin panel schema — tables");
  const adminTables = (await prisma.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('plans','plan_overrides','subscriptions','payments',
                          'audit_logs','announcements','support_tickets')
     ORDER BY table_name`
  )) as Array<{ table_name: string }>;
  for (const r of adminTables) console.log("  ", r.table_name);
  console.log(`  count: ${adminTables.length}/7`);

  header("(B) admin panel schema — added columns on companies + users");
  const addedCols = (await prisma.$queryRawUnsafe(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND ((table_name = 'companies' AND column_name IN
              ('billingEmail','country','deletedAt','industry','size',
               'status','suspendReason','suspendedAt','trialEndsAt'))
         OR (table_name = 'users' AND column_name IN
              ('disabledAt','disabledReason','status')))
     ORDER BY table_name, column_name`
  )) as Array<{ table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }>;
  for (const r of addedCols) {
    console.log(
      `  ${r.table_name}.${r.column_name}  type=${r.data_type}  nullable=${r.is_nullable}  default=${r.column_default ?? "(none)"}`
    );
  }
  console.log(`  count: ${addedCols.length}/12 (9 on companies + 3 on users)`);

  header("(C) admin panel schema — indexes");
  const adminIdx = (await prisma.$queryRawUnsafe(
    `SELECT indexname, tablename FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname IN (
         'plans_pkey','plans_slug_key',
         'plan_overrides_pkey','plan_overrides_companyId_idx',
         'plan_overrides_featureSlug_idx','plan_overrides_companyId_featureSlug_key',
         'subscriptions_pkey','subscriptions_companyId_idx',
         'subscriptions_planId_idx','subscriptions_status_idx',
         'payments_pkey','payments_companyId_idx','payments_subscriptionId_idx',
         'payments_status_idx','payments_gateway_idx','payments_gatewayPaymentId_idx',
         'audit_logs_pkey','audit_logs_userId_idx','audit_logs_companyId_idx',
         'audit_logs_action_idx','audit_logs_entityType_entityId_idx',
         'audit_logs_createdAt_idx',
         'announcements_pkey','announcements_isActive_idx','announcements_target_idx',
         'support_tickets_pkey','support_tickets_companyId_idx',
         'support_tickets_status_idx','support_tickets_priority_idx',
         'support_tickets_assignedToId_idx',
         'companies_status_idx','companies_plan_idx',
         'users_role_idx','users_status_idx'
       )
     ORDER BY tablename, indexname`
  )) as Array<{ indexname: string; tablename: string }>;
  for (const r of adminIdx) console.log(`  ${r.tablename}.${r.indexname}`);
  console.log(`  count: ${adminIdx.length}/34`);

  header("(D) admin panel schema — foreign keys");
  const adminFks = (await prisma.$queryRawUnsafe(
    `SELECT c.conname, t.relname AS table_name,
            pg_get_constraintdef(c.oid) AS def
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     WHERE c.contype = 'f'
       AND c.conname IN (
         'plan_overrides_companyId_fkey',
         'subscriptions_companyId_fkey','subscriptions_planId_fkey',
         'payments_companyId_fkey','payments_subscriptionId_fkey',
         'audit_logs_userId_fkey','audit_logs_companyId_fkey',
         'support_tickets_companyId_fkey',
         'support_tickets_createdById_fkey',
         'support_tickets_assignedToId_fkey'
       )
     ORDER BY c.conname`
  )) as Array<{ conname: string; table_name: string; def: string }>;
  for (const r of adminFks) {
    console.log(`  ${r.table_name}.${r.conname}`);
    console.log(`    def: ${r.def}`);
  }
  console.log(`  count: ${adminFks.length}/10`);

  // ─────────────────────────────────────────────────────────────────
  // 20260422100000_password_reset_tokens
  // ─────────────────────────────────────────────────────────────────
  header("(E) password_reset_tokens — table");
  const prtTable = (await prisma.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'password_reset_tokens'`
  )) as Array<{ table_name: string }>;
  for (const r of prtTable) console.log("  ", r.table_name);

  header("(F) password_reset_tokens — columns");
  const prtCols = (await prisma.$queryRawUnsafe(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'password_reset_tokens'
     ORDER BY ordinal_position`
  )) as Array<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>;
  for (const r of prtCols) {
    console.log(
      `  ${r.column_name}  type=${r.data_type}  nullable=${r.is_nullable}  default=${r.column_default ?? "(none)"}`
    );
  }
  console.log(`  count: ${prtCols.length}/8`);

  header("(G) password_reset_tokens — indexes");
  const prtIdx = (await prisma.$queryRawUnsafe(
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'password_reset_tokens'
     ORDER BY indexname`
  )) as Array<{ indexname: string; indexdef: string }>;
  for (const r of prtIdx) {
    console.log(`  ${r.indexname}`);
    console.log(`    def: ${r.indexdef}`);
  }

  header("(H) password_reset_tokens — constraints");
  const prtCons = (await prisma.$queryRawUnsafe(
    `SELECT c.conname, c.contype, pg_get_constraintdef(c.oid) AS def
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'password_reset_tokens'
     ORDER BY c.conname`
  )) as Array<{ conname: string; contype: string; def: string }>;
  for (const r of prtCons) {
    console.log(`  ${r.conname}  contype=${r.contype}`);
    console.log(`    def: ${r.def}`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    return prisma.$disconnect().then(() => process.exit(1));
  });
