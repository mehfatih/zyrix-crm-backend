import { prisma } from "../src/config/database";

async function main() {
  const tables = (await prisma.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name IN ('brands','brand_settings')
     ORDER BY table_name`
  )) as Array<{ table_name: string }>;
  console.log("brand-related tables present:", tables);

  const cols = (await prisma.$queryRawUnsafe(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN ('customers','deals','activities')
       AND column_name = 'brandId'
     ORDER BY table_name`
  )) as Array<{ table_name: string; column_name: string }>;
  console.log("brandId tag columns present:", cols);

  const migs = (await prisma.$queryRawUnsafe(
    `SELECT migration_name, finished_at IS NOT NULL AS applied
     FROM _prisma_migrations
     WHERE migration_name LIKE '%brand%' OR migration_name LIKE '%docs_sprint%'
        OR migration_name LIKE '%bonus%' OR migration_name LIKE '%scim%'
        OR migration_name LIKE '%retention%' OR migration_name LIKE '%network%'
        OR migration_name LIKE '%enabled_features%'
     ORDER BY migration_name`
  )) as Array<{ migration_name: string; applied: boolean }>;
  console.log("brand-related migration rows:", migs);

  const lastFew = (await prisma.$queryRawUnsafe(
    `SELECT migration_name, finished_at IS NOT NULL AS applied
     FROM _prisma_migrations ORDER BY started_at DESC LIMIT 8`
  )) as Array<{ migration_name: string; applied: boolean }>;
  console.log("most-recent migrations in DB:", lastFew);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    return prisma.$disconnect().then(() => process.exit(1));
  });
