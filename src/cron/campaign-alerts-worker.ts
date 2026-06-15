// ============================================================================
// CAMPAIGN ALERTS WORKER (Sprint 24D) — daily sweep of alerts-enabled ad
// campaigns; pings owners/managers when ROAS drops below / CPA rises above the
// campaign's threshold. Per-company gated by `campaign_economics` inside
// sweepCampaignAlerts(); deduped per kind (24h) off the notifications table.
// Opt out entirely with DISABLE_CAMPAIGN_ALERTS_CRON=true.
// ============================================================================

import cron from "node-cron";
import { sweepCampaignAlerts } from "../services/ad-campaign.service";

const CRON_EXPRESSION = "0 8 * * *"; // daily at 08:00 (server UTC)
let running = false;

async function runOnce(reason: string): Promise<void> {
  if (running) return;
  running = true;
  try {
    const { scanned, alerted } = await sweepCampaignAlerts();
    if (alerted > 0) console.log(`[campaign-alerts] ${reason}: ${alerted} alert(s) across ${scanned} campaign(s)`);
  } catch (e) {
    console.error("[campaign-alerts] sweep failed:", (e as Error).message);
  } finally {
    running = false;
  }
}

export function startCampaignAlertsWorker(): void {
  if (process.env.DISABLE_CAMPAIGN_ALERTS_CRON === "true") {
    console.log("[campaign-alerts] cron DISABLED via DISABLE_CAMPAIGN_ALERTS_CRON");
    return;
  }
  if (!cron.validate(CRON_EXPRESSION)) {
    console.error(`[campaign-alerts] invalid schedule: ${CRON_EXPRESSION}`);
    return;
  }
  cron.schedule(CRON_EXPRESSION, () => {
    void runOnce("daily-sweep");
  });
  console.log("[campaign-alerts] cron scheduled daily at 08:00");
}
