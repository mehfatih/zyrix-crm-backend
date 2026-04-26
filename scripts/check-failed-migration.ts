import { prisma } from "../src/config/database";

async function main() {
  const row = (await prisma.$queryRawUnsafe(
    `SELECT id, migration_name, started_at, finished_at, logs, rolled_back_at
     FROM _prisma_migrations
     WHERE migration_name = '20260430100000_add_ai_agents'`
  )) as any[];
  console.log(JSON.stringify(row, null, 2));
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => { console.error(e); return prisma.$disconnect().then(() => process.exit(1)); });
