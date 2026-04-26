/**
 * Answers parts B and C of the fix-sprint planning ask:
 *   B) Run the three '%ai_agent%' partial-state probes the user requested.
 *      The migration is misnamed — it creates ai_threads and ai_messages,
 *      not anything called ai_agent — so the literal pattern returns
 *      empty. We re-run the same probes with the real table names so the
 *      live state is visible.
 *   C) List every migration folder that comes after the failed
 *      20260430 row chronologically and confirm none of them appear in
 *      _prisma_migrations.
 */
import { prisma } from "../src/config/database";
import * as fs from "fs";
import * as path from "path";

async function main() {
  // ── Part B (literal user queries) ────────────────────────────────────
  console.log("=== B (literal): %ai_agent% probes ===");
  const tablesAi = await prisma.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_name LIKE '%ai_agent%'`
  );
  console.log("tables LIKE '%ai_agent%':", tablesAi);
  const consAi = await prisma.$queryRawUnsafe(
    `SELECT conname FROM pg_constraint WHERE conname LIKE '%ai_agent%'`
  );
  console.log("constraints LIKE '%ai_agent%':", consAi);
  const ixAi = await prisma.$queryRawUnsafe(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname='public' AND indexname LIKE '%ai_agent%'`
  );
  console.log("indexes LIKE '%ai_agent%':", ixAi);

  // ── Part B (real names, since the migration creates ai_threads + ai_messages) ──
  console.log("\n=== B (corrected): real objects the migration was supposed to create ===");
  const tablesReal = await prisma.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_name IN ('ai_threads','ai_messages')
     ORDER BY table_name`
  );
  console.log("ai_threads / ai_messages tables present:", tablesReal);
  const consReal = await prisma.$queryRawUnsafe(
    `SELECT c.conname, c.contype, t.relname AS table_name
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname IN ('ai_threads','ai_messages')
     ORDER BY t.relname, c.conname`
  );
  console.log("constraints on ai_threads / ai_messages:");
  for (const r of consReal as any[]) {
    console.log(`  ${r.table_name}.${r.conname} (contype=${r.contype})`);
  }
  const ixReal = await prisma.$queryRawUnsafe(
    `SELECT indexname, tablename FROM pg_indexes
     WHERE schemaname='public' AND tablename IN ('ai_threads','ai_messages')
     ORDER BY tablename, indexname`
  );
  console.log("indexes on ai_threads / ai_messages:");
  for (const r of ixReal as any[]) {
    console.log(`  ${r.tablename}.${r.indexname}`);
  }

  // ── Part C — every folder after 20260430, with _prisma_migrations status ──
  console.log("\n=== C: blocked migrations (folders dated > 20260430100000) ===");
  const dir = path.resolve(process.cwd(), "prisma/migrations");
  const folders = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => /^\d{14}_/.test(n)) // skip migration_lock and other files
    .filter((n) => n > "20260430100000_add_ai_agents")
    .sort();

  const dbRows = (await prisma.$queryRawUnsafe(
    `SELECT migration_name, finished_at IS NOT NULL AS applied, rolled_back_at
     FROM _prisma_migrations`
  )) as Array<{ migration_name: string; applied: boolean; rolled_back_at: Date | null }>;
  const dbMap = new Map(dbRows.map((r) => [r.migration_name, r]));

  console.log(`folders after 20260430100000_add_ai_agents (${folders.length} total):`);
  let absentCount = 0;
  let presentCount = 0;
  for (const name of folders) {
    const row = dbMap.get(name);
    if (!row) {
      absentCount++;
      console.log(`  ${name}  ->  NOT in _prisma_migrations`);
    } else if (row.rolled_back_at) {
      presentCount++;
      console.log(`  ${name}  ->  in _prisma_migrations as ROLLED BACK`);
    } else if (row.applied) {
      presentCount++;
      console.log(`  ${name}  ->  in _prisma_migrations as APPLIED (!)`);
    } else {
      presentCount++;
      console.log(`  ${name}  ->  in _prisma_migrations as FAILED`);
    }
  }
  console.log(`\nsummary: ${absentCount}/${folders.length} blocked migrations missing from _prisma_migrations, ${presentCount} present`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    return prisma.$disconnect().then(() => process.exit(1));
  });
