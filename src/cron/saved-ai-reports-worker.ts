// ============================================================================
// SAVED AI REPORTS WORKER (Sprint 13)
// ----------------------------------------------------------------------------
// Runs daily at 06:23 UTC. Generates every due AI-prompt report (daily/weekly),
// stores lastResult, and emails recipients. Per-report isolation lives in
// runDueReports — one failing report never blocks the rest, and a model outage
// is logged onto the row (model-retirement runbook in CLAUDE.md applies).
// Distinct from scheduled-reports-worker (which sends metric digests).
// ============================================================================

import cron from "node-cron";
import { runDueReports } from "../services/saved-ai-reports.service";

const CRON_EXPRESSION = "23 6 * * *"; // 06:23 UTC daily

let running = false;

export function startSavedAiReportsWorker(): void {
  if (process.env.DISABLE_SAVED_AI_REPORTS_CRON === "true") {
    console.log("[ai-reports] cron DISABLED via DISABLE_SAVED_AI_REPORTS_CRON");
    return;
  }
  if (!cron.validate(CRON_EXPRESSION)) {
    console.error(`[ai-reports] invalid schedule: ${CRON_EXPRESSION}`);
    return;
  }
  cron.schedule(CRON_EXPRESSION, async () => {
    if (running) return; // never overlap
    running = true;
    try {
      const { ran, failed } = await runDueReports(new Date());
      if (ran || failed) console.log(`[ai-reports] ran ${ran}, failed ${failed}`);
    } catch (e) {
      console.error("[ai-reports] worker crashed:", (e as Error).message);
    } finally {
      running = false;
    }
  });
  console.log("[ai-reports] daily cron scheduled for 06:23 UTC");
}
