/**
 * Sprint C1 fix-planning probe — pure SELECT only.
 * Runs items (a), (b), (c), (f), (g) of the planning brief against the
 * configured DATABASE_URL.  No writes, no DDL, no transactions.
 */
import { prisma } from "../src/config/database";

function header(s: string) {
  console.log("\n" + "=".repeat(70));
  console.log(s);
  console.log("=".repeat(70));
}

async function main() {
  // (a) Tables the failed migration intended to create
  header("(a) tables ai_threads / ai_messages");
  const a = (await prisma.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('ai_threads', 'ai_messages')
     ORDER BY table_name`
  )) as Array<{ table_name: string }>;
  for (const r of a) console.log("  ", r.table_name);

  // (b) Columns for those tables
  header("(b) columns on ai_threads / ai_messages");
  const b = (await prisma.$queryRawUnsafe(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN ('ai_threads', 'ai_messages')
     ORDER BY table_name, ordinal_position`
  )) as Array<{ table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }>;
  for (const r of b) {
    console.log(
      `  ${r.table_name}.${r.column_name}  type=${r.data_type}  nullable=${r.is_nullable}  default=${r.column_default ?? "(none)"}`
    );
  }

  // (c) Constraints and indexes on those tables
  header("(c1) constraints on ai_threads / ai_messages");
  const c1 = (await prisma.$queryRawUnsafe(
    `SELECT conname, contype, pg_get_constraintdef(oid) AS def
     FROM pg_constraint
     WHERE conrelid IN (
       SELECT oid FROM pg_class WHERE relname IN ('ai_threads', 'ai_messages')
     )
     ORDER BY conname`
  )) as Array<{ conname: string; contype: string; def: string }>;
  for (const r of c1) {
    console.log(`  ${r.conname}  contype=${r.contype}`);
    console.log(`    def: ${r.def}`);
  }

  header("(c2) indexes on ai_threads / ai_messages");
  const c2 = (await prisma.$queryRawUnsafe(
    `SELECT indexname, indexdef
     FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename IN ('ai_threads', 'ai_messages')
     ORDER BY indexname`
  )) as Array<{ indexname: string; indexdef: string }>;
  for (const r of c2) {
    console.log(`  ${r.indexname}`);
    console.log(`    def: ${r.indexdef}`);
  }

  // (f) Brand migration tables — should both be absent
  header("(f) tables brands / brand_settings");
  const f = (await prisma.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('brands', 'brand_settings')
     ORDER BY table_name`
  )) as Array<{ table_name: string }>;
  if (f.length === 0) console.log("  (none — both absent, as expected)");
  for (const r of f) console.log("  ", r.table_name);

  // (g) Full _prisma_migrations chronology
  header("(g) _prisma_migrations rows ordered by started_at");
  const g = (await prisma.$queryRawUnsafe(
    `SELECT migration_name, started_at, finished_at, rolled_back_at
     FROM _prisma_migrations
     ORDER BY started_at`
  )) as Array<{
    migration_name: string;
    started_at: Date;
    finished_at: Date | null;
    rolled_back_at: Date | null;
  }>;
  for (const r of g) {
    const status = r.rolled_back_at
      ? "ROLLED_BACK"
      : r.finished_at
        ? "applied"
        : "FAILED (no finished_at)";
    console.log(
      `  ${r.migration_name}  started=${r.started_at.toISOString()}  status=${status}`
    );
  }
  console.log(`  total rows: ${g.length}`);

  // (h) Cross-reference with on-disk folder names dated > 20260430100000_add_ai_agents
  header("(h) on-disk folders dated AFTER 20260430100000_add_ai_agents vs (g)");
  const fs = await import("fs");
  const path = await import("path");
  const dir = path.resolve(process.cwd(), "prisma/migrations");
  const folders = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => /^\d{14}_/.test(n))
    .filter((n) => n > "20260430100000_add_ai_agents")
    .sort();
  const dbNames = new Set(g.map((r) => r.migration_name));
  let absent = 0;
  let present = 0;
  for (const name of folders) {
    if (dbNames.has(name)) {
      console.log(`  ${name}  ->  PRESENT in _prisma_migrations`);
      present++;
    } else {
      console.log(`  ${name}  ->  ABSENT from _prisma_migrations`);
      absent++;
    }
  }
  console.log(`  summary: ${absent} absent, ${present} present (of ${folders.length} folders)`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    return prisma.$disconnect().then(() => process.exit(1));
  });
