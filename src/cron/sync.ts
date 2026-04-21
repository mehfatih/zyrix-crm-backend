import cron from "node-cron";
import { prisma } from "../config/database";
import { syncStore } from "../services/ecommerce.service";
import { retryPendingEvents } from "../services/webhook.service";

// ============================================================================
// SCHEDULED AUTO-SYNC
// ----------------------------------------------------------------------------
// Runs every hour. For each active e-commerce store where lastSyncAt was
// more than SYNC_INTERVAL_MS ago (or null), it triggers syncStore(). Stores
// are processed sequentially per-company to avoid hammering a single admin
// API. Between any two API-calling operations we sleep a small amount so a
// burst of new connections across many companies doesn't pin CPU.
//
// Operational safety:
//   • In-memory mutex isRunning prevents a long sync run from overlapping
//     with the next tick (which would double-count imports).
//   • Each store sync is wrapped in try/catch so one failing store never
//     blocks the rest of the queue. Failures already persist to
//     store.syncStatus='error' + syncError inside syncStore() itself.
//   • The scheduler registers once at process boot; Railway restarts of
//     the container re-register naturally.
//   • An env flag DISABLE_CRON_SYNC=true lets ops turn this off without
//     a code deploy (useful during incidents).
// ============================================================================

const SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour minimum gap between syncs
const PER_STORE_DELAY_MS = 2000; // polite 2s pause between stores
const CRON_EXPRESSION = "0 * * * *"; // top of every hour

let isRunning = false;

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runScheduledSync(): Promise<{
  attempted: number;
  ok: number;
  failed: number;
  skipped: number;
}> {
  if (isRunning) {
    console.log("[cron] sync tick skipped — previous run still in flight");
    return { attempted: 0, ok: 0, failed: 0, skipped: 0 };
  }
  isRunning = true;
  const stats = { attempted: 0, ok: 0, failed: 0, skipped: 0 };

  try {
    const cutoff = new Date(Date.now() - SYNC_INTERVAL_MS);

    // Pull stores that are active AND either never synced OR stale.
    // Order by lastSyncAt asc so oldest gets serviced first.
    const stores = await prisma.ecommerceStore.findMany({
      where: {
        isActive: true,
        OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: cutoff } }],
      },
      orderBy: [{ lastSyncAt: "asc" }, { createdAt: "asc" }],
      select: { id: true, companyId: true, platform: true, shopDomain: true },
      take: 100, // safety cap — an hour is plenty for 100 stores
    });

    console.log(`[cron] sync tick: ${stores.length} stores eligible`);

    for (const store of stores) {
      stats.attempted++;
      try {
        const res = await syncStore(store.companyId, store.id);
        stats.ok++;
        console.log(
          `[cron] synced ${store.platform}/${store.shopDomain} — ${res.imported} customers, ${res.orders} orders`
        );
      } catch (e: any) {
        // Handle the 'csv_only/planned platform' rejection from syncStore
        if (e?.statusCode === 400 && /CSV/i.test(e?.message || "")) {
          stats.skipped++;
        } else {
          stats.failed++;
          console.error(
            `[cron] sync failed ${store.platform}/${store.shopDomain}:`,
            e?.message || e
          );
        }
      }
      await sleep(PER_STORE_DELAY_MS);
    }
  } catch (e: any) {
    console.error("[cron] sync tick errored at the top level:", e?.message || e);
  } finally {
    isRunning = false;
  }

  console.log(
    `[cron] tick complete — attempted=${stats.attempted} ok=${stats.ok} failed=${stats.failed} skipped=${stats.skipped}`
  );
  return stats;
}

export function startSyncScheduler(): void {
  if (process.env.DISABLE_CRON_SYNC === "true") {
    console.log(
      "[cron] sync scheduler DISABLED via DISABLE_CRON_SYNC env flag"
    );
    return;
  }

  // node-cron validates expressions — this throws synchronously on invalid
  if (!cron.validate(CRON_EXPRESSION)) {
    console.error(`[cron] invalid schedule expression: ${CRON_EXPRESSION}`);
    return;
  }

  cron.schedule(CRON_EXPRESSION, () => {
    runScheduledSync().catch((e) => {
      // Defensive — runScheduledSync already catches, but belt-and-braces.
      console.error("[cron] unhandled rejection from runScheduledSync:", e);
    });
  });

  console.log(
    `[cron] sync scheduler registered — "${CRON_EXPRESSION}" (hourly)`
  );

  // ─── Webhook retry worker ────────────────────────────────────────────
  // Every 2 minutes, pick up failed webhook events whose nextRetryAt has
  // come around and re-run them through processEvent. This is separate
  // from the hourly store sync because the first backoff bucket is 1 min
  // — running hourly would introduce up to 59 minutes of unnecessary
  // delay on the first retry.
  const WEBHOOK_RETRY_CRON = "*/2 * * * *";
  if (!cron.validate(WEBHOOK_RETRY_CRON)) {
    console.error(`[cron] invalid retry schedule: ${WEBHOOK_RETRY_CRON}`);
    return;
  }
  let retryInFlight = false;
  cron.schedule(WEBHOOK_RETRY_CRON, () => {
    if (retryInFlight) return; // mutex — skip tick if previous still running
    retryInFlight = true;
    retryPendingEvents()
      .then((stats) => {
        if (stats.picked > 0) {
          console.log(
            `[cron] webhook retries — picked=${stats.picked} ok=${stats.ok} failed=${stats.failed}`
          );
        }
      })
      .catch((e) => {
        console.error("[cron] webhook retry tick errored:", e?.message || e);
      })
      .finally(() => {
        retryInFlight = false;
      });
  });
  console.log(
    `[cron] webhook retry scheduler registered — "${WEBHOOK_RETRY_CRON}" (every 2 min)`
  );
}
