import { prisma } from "../src/config/database";
(async () => {
  const cols = await prisma.$queryRawUnsafe<any[]>(
    `SELECT column_name, data_type, column_default FROM information_schema.columns WHERE table_name='calendar_connections' ORDER BY ordinal_position`
  );
  const idx = await prisma.$queryRawUnsafe<any[]>(
    `SELECT indexname FROM pg_indexes WHERE tablename='calendar_connections' ORDER BY indexname`
  );
  console.log("calendar_connections columns:");
  for (const c of cols) console.log(`  ${c.column_name} :: ${c.data_type}${c.column_default ? " = " + c.column_default : ""}`);
  console.log("indexes:", idx.map((i) => i.indexname).join(", "));
  console.log("COLUMN_COUNT", cols.length);
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
