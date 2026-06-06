// SPRINT 16A — apply Mehmet's tenant decisions. Idempotent. READ-ONLY unless
// --confirm is passed. Run: npx tsx scripts/s16a-apply-decisions.ts --confirm
//
//   • Levana (dd6a005d)        → plan = enterprise (full unrestricted access)
//   • Zyrix System (bc1fe342)  → leave enterprise (untouched)
//   • Maher (6cd7f641)         → purge (soft-delete) — confirmed ZERO data
//   • S15E (a68ff663)          → purge (soft-delete)
//   • S15C Verify (a90f615c)   → purge (soft-delete)
import "dotenv/config";
import { prisma } from "../src/config/database";

const CONFIRM = process.argv.includes("--confirm");
const LEVANA = "dd6a005d-6abf-4d70-bcb1-eeac9c7cb92c";
const PURGE = [
  "6cd7f641-9c59-477e-808a-0649f5f00845", // Maher Ayman
  "a68ff663-896d-4eeb-968d-069d2bd00384", // S15E
  "a90f615c-cfac-464d-bb25-2933fee484e1", // S15C Verify
];

async function snapshot(label: string) {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id, name, plan, status, "deletedAt" FROM companies ORDER BY "createdAt" ASC`
  )) as any[];
  console.log(`\n--- companies (${label}) ---`);
  for (const r of rows) {
    console.log(`  ${r.name.slice(0, 38).padEnd(40)} plan=${(r.plan || "").padEnd(10)} status=${(r.status || "").padEnd(9)} ${r.deletedAt ? "deletedAt=" + new Date(r.deletedAt).toISOString() : ""}`);
  }
}

async function main() {
  await snapshot("before");
  if (!CONFIRM) {
    console.log("\n(DRY RUN — pass --confirm to apply)");
    await prisma.$disconnect();
    return;
  }

  // Levana → enterprise
  const lev = await prisma.$executeRawUnsafe(
    `UPDATE companies SET "plan" = 'enterprise', "updatedAt" = NOW() WHERE id = $1`,
    LEVANA
  );
  console.log(`\nLevana → enterprise (${lev} row)`);

  // Purge (soft-delete) the shells — guard: never touch zyrix-system slug.
  for (const id of PURGE) {
    const r = await prisma.$executeRawUnsafe(
      `UPDATE companies SET "status" = 'deleted', "deletedAt" = NOW(), "updatedAt" = NOW()
         WHERE id = $1 AND "slug" <> 'zyrix-system' AND "deletedAt" IS NULL`,
      id
    );
    console.log(`  purged ${id} (${r} row)`);
  }

  // Invalidate any cached entitlement state for the changed tenants.
  try {
    const { invalidateAll } = await import("../src/services/entitlements.service");
    invalidateAll();
  } catch {}

  await snapshot("after");
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
