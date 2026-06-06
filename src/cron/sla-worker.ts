// ============================================================================
// SLA WORKER (Sprint 18B) — sweeps open tickets every 5 min for SLA breaches.
// Per-company gated by the `service_sla` entitlement inside sweepBreaches().
// Opt out entirely with DISABLE_SLA_CRON=true.
// ============================================================================

import cron from "node-cron";
import { sweepBreaches } from "../services/sla.service";

const CRON_EXPRESSION = "*/5 * * * *"; // every 5 minutes
let running = false;

async function runOnce(reason: string): Promise<void> {
  if (running) return;
  running = true;
  try {
    const { scanned, breached } = await sweepBreaches();
    if (breached > 0) console.log(`[sla] ${reason}: ${breached} breach(es) across ${scanned} open ticket(s)`);
  } catch (e) {
    console.error("[sla] sweep failed:", (e as Error).message);
  } finally {
    running = false;
  }
}

export function startSlaWorker(): void {
  if (process.env.DISABLE_SLA_CRON === "true") {
    console.log("[sla] cron DISABLED via DISABLE_SLA_CRON");
    return;
  }
  if (!cron.validate(CRON_EXPRESSION)) {
    console.error(`[sla] invalid schedule: ${CRON_EXPRESSION}`);
    return;
  }
  cron.schedule(CRON_EXPRESSION, () => {
    void runOnce("5min-sweep");
  });
  console.log("[sla] cron scheduled every 5 min");
}
