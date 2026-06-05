import cron from "node-cron";
import { prisma } from "../config/database";
import { dispatchProductLowStock } from "../services/workflow-events.service";
import { createNotification } from "../services/notifications.service";

// ============================================================================
// DAILY LOW-STOCK SCAN (Sprint 8)
// ----------------------------------------------------------------------------
// Once a day, find every ACTIVE product whose on-hand level has dropped to or
// below its low-stock threshold and:
//   1. fire the `product.low_stock` automation trigger (merchants build
//      "notify owner + create purchase task" rules on it), and
//   2. create an in-app notification fallback for the company owners/admins.
//
// The in-app fallback is deduped on a 20h window so the bell tray doesn't
// accumulate an identical item on every daily run while a product stays low.
// Disable with DISABLE_LOWSTOCK_CRON=true.
// ============================================================================

const CRON_EXPRESSION = "0 8 * * *"; // daily at 08:00 (server TZ)
let isRunning = false;

interface LowRow {
  id: string;
  companyId: string;
  name: string;
  sku: string | null;
  location: string;
  qty: string;
  threshold: string;
}

export async function runLowStockScan(): Promise<{
  lowStock: number;
  triggered: number;
  notified: number;
}> {
  if (isRunning) return { lowStock: 0, triggered: 0, notified: 0 };
  isRunning = true;
  let triggered = 0;
  let notified = 0;
  let rows: LowRow[] = [];
  try {
    rows = (await prisma.$queryRawUnsafe(
      `SELECT p.id, p."companyId", p.name, p.sku, sl.location,
              sl.qty::text AS qty, sl."lowStockThreshold"::text AS threshold
         FROM stock_levels sl
         JOIN products p ON p.id = sl."productId"
        WHERE sl."lowStockThreshold" IS NOT NULL
          AND sl.qty <= sl."lowStockThreshold"
          AND p.status = 'active'`
    )) as LowRow[];

    for (const r of rows) {
      const qty = Number(r.qty);
      const threshold = Number(r.threshold);

      // 1) Automation trigger — fire-and-forget, never throws.
      await dispatchProductLowStock(r.companyId, {
        id: r.id,
        name: r.name,
        sku: r.sku,
        location: r.location,
        qty,
        lowStockThreshold: threshold,
      });
      triggered++;

      // 2) In-app fallback to owners/admins (deduped over 20h).
      try {
        const recent = (await prisma.$queryRawUnsafe(
          `SELECT 1 FROM notifications
            WHERE "companyId" = $1 AND "entityType" = 'product' AND "entityId" = $2
              AND kind = 'product_low_stock'
              AND "createdAt" > now() - interval '20 hours'
            LIMIT 1`,
          r.companyId,
          r.id
        )) as unknown[];
        if (recent.length > 0) continue;

        const owners = (await prisma.$queryRawUnsafe(
          `SELECT id FROM users WHERE "companyId" = $1 AND role IN ('owner', 'admin')`,
          r.companyId
        )) as Array<{ id: string }>;

        const where =
          r.location !== "main" ? ` at ${r.location}` : "";
        for (const o of owners) {
          await createNotification({
            companyId: r.companyId,
            userId: o.id,
            kind: "product_low_stock",
            title: `Low stock: ${r.name}`,
            body: `${qty} on hand (threshold ${threshold})${where}.`,
            link: `/products`,
            entityType: "product",
            entityId: r.id,
          });
          notified++;
        }
      } catch (e) {
        // Notification is best-effort; the trigger already fired.
        console.error(
          "[cron] low-stock notify failed for product",
          r.id,
          (e as Error).message
        );
      }
    }
  } catch (e) {
    console.error("[cron] low-stock scan failed:", (e as Error).message);
  } finally {
    isRunning = false;
  }
  return { lowStock: rows.length, triggered, notified };
}

export function startLowStockCron(): void {
  if (process.env.DISABLE_LOWSTOCK_CRON === "true") {
    console.log("[cron] low-stock scan DISABLED via DISABLE_LOWSTOCK_CRON");
    return;
  }
  if (!cron.validate(CRON_EXPRESSION)) {
    console.error(`[cron] invalid low-stock schedule: ${CRON_EXPRESSION}`);
    return;
  }
  cron.schedule(CRON_EXPRESSION, () => {
    runLowStockScan().catch((e) =>
      console.error("[cron] low-stock scan rejection:", e)
    );
  });
  console.log(`[cron] low-stock scan registered — "${CRON_EXPRESSION}" (daily)`);
}
