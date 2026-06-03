import cron from "node-cron";
import { prisma } from "../config/database";
import { runShopifySync } from "../services/shopify/sync";
import type { ShopifyConnectionRow } from "../services/shopify/connections.service";

// ============================================================================
// SHOPIFY OAUTH CONNECTION RECONCILIATION SYNC
// ----------------------------------------------------------------------------
// RECONCILIATION SAFETY NET — real-time webhooks (services/shopify/webhooks.ts)
// are the PRIMARY sync path. This low-frequency poll (every 6h) re-syncs
// 'connected' shopify_connections whose lastSyncAt is stale, to catch any
// webhook that was missed (delivery failure, downtime, etc.). Self-contained
// so OAuth tokens stay encrypted at rest. Mutex prevents overlapping ticks;
// per-store delay keeps us polite. needs_reauth/revoked connections are
// skipped (they require the merchant to reconnect).
//
// Disable with DISABLE_CRON_SYNC=true (shared with the legacy sync flag).
// ============================================================================

const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // re-sync if not synced in 6h
const PER_STORE_DELAY_MS = 2000;
const CRON_EXPRESSION = "23 */6 * * *"; // every 6h at :23 — reconciliation only

let isRunning = false;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runScheduledShopifySync(): Promise<{
  attempted: number;
  ok: number;
  failed: number;
}> {
  if (isRunning) {
    console.log("[cron] shopify sync tick skipped — previous still in flight");
    return { attempted: 0, ok: 0, failed: 0 };
  }
  isRunning = true;
  const stats = { attempted: 0, ok: 0, failed: 0 };
  try {
    const cutoff = new Date(Date.now() - SYNC_INTERVAL_MS);
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT "id", "companyId", "shopDomain", "status",
              "accessTokenCiphertext", "accessTokenIv", "accessTokenTag",
              "refreshTokenCiphertext", "refreshTokenIv", "refreshTokenTag",
              "tokenExpiresAt", "refreshTokenExpiresAt", "scopes",
              "lastSyncAt", "lastSyncDurationMs", "lastError", "ecommerceStoreId",
              "createdAt", "updatedAt"
         FROM shopify_connections
        WHERE "status" = 'connected'
          AND ("lastSyncAt" IS NULL OR "lastSyncAt" < $1)
        ORDER BY "lastSyncAt" ASC NULLS FIRST
        LIMIT 100`,
      cutoff
    )) as ShopifyConnectionRow[];

    console.log(`[cron] shopify sync tick: ${rows.length} connections eligible`);
    for (const conn of rows) {
      stats.attempted++;
      const result = await runShopifySync(conn);
      if (result) stats.ok++;
      else stats.failed++;
      await sleep(PER_STORE_DELAY_MS);
    }
  } catch (e: any) {
    console.error("[cron] shopify sync tick errored:", e?.message || e);
  } finally {
    isRunning = false;
  }
  console.log(
    `[cron] shopify sync complete — attempted=${stats.attempted} ok=${stats.ok} failed=${stats.failed}`
  );
  return stats;
}

export function startShopifyConnectionSync(): void {
  if (process.env.DISABLE_CRON_SYNC === "true") {
    console.log("[cron] shopify connection sync DISABLED via DISABLE_CRON_SYNC");
    return;
  }
  if (!cron.validate(CRON_EXPRESSION)) {
    console.error(`[cron] invalid shopify sync schedule: ${CRON_EXPRESSION}`);
    return;
  }
  cron.schedule(CRON_EXPRESSION, () => {
    runScheduledShopifySync().catch((e) =>
      console.error("[cron] unhandled shopify sync rejection:", e)
    );
  });
  console.log(
    `[cron] shopify reconciliation sync registered — "${CRON_EXPRESSION}" (every 6h; webhooks are primary)`
  );
}
