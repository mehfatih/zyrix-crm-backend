// ============================================================================
// FX RATES WORKER (Sprint 15B)
// ----------------------------------------------------------------------------
// Daily at 08:10 UTC (after the low-stock scan) fetch + store live USD-base FX
// rates from open.er-api.com. On startup, if the table is empty, fetch once
// immediately so reports have rates before the first scheduled tick.
// DISABLE_FX_CRON=true opts out.
// ============================================================================

import cron from "node-cron";
import { fetchAndStoreRates, hasAnyRates } from "../services/fx-rates.service";

const CRON_EXPRESSION = "10 8 * * *"; // 08:10 UTC daily

let running = false;

async function runOnce(reason: string): Promise<void> {
  if (running) return;
  running = true;
  try {
    const { stored, rateDate } = await fetchAndStoreRates();
    console.log(`[fx] ${reason}: stored ${stored} rates for ${rateDate}`);
  } catch (e) {
    console.error("[fx] fetch failed:", (e as Error).message);
  } finally {
    running = false;
  }
}

export function startFxRatesWorker(): void {
  if (process.env.DISABLE_FX_CRON === "true") {
    console.log("[fx] cron DISABLED via DISABLE_FX_CRON");
    return;
  }
  if (!cron.validate(CRON_EXPRESSION)) {
    console.error(`[fx] invalid schedule: ${CRON_EXPRESSION}`);
    return;
  }
  cron.schedule(CRON_EXPRESSION, () => {
    void runOnce("daily");
  });
  console.log("[fx] daily cron scheduled for 08:10 UTC");

  // Seed once on boot if empty (non-blocking) so reports aren't stuck on stale
  // DEFAULT constants until the first scheduled run.
  void (async () => {
    try {
      if (!(await hasAnyRates())) await runOnce("startup-seed");
    } catch (e) {
      console.error("[fx] startup-seed check failed:", (e as Error).message);
    }
  })();
}
