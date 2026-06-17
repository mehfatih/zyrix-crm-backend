// ============================================================================
// CAC RESEARCH WORKER (Sprint 3, Phase 2) — weekly refresh of the live web-
// research ENRICHMENT cache (cac_research_cache). Re-grounds the small fixed
// industry×topic allowlist (~15 cells platform-wide) via cac-research.service.
//
// DOUBLE-GATED + DEFAULT OFF: runs ONLY when CAC_RESEARCH_ENABLED=true. Opt the
// cron out separately with DISABLE_CAC_RESEARCH_CRON=true. Flag off → worker
// never schedules → table empty → /cac is byte-identical to Phase 1.
//
// Single-run guard + try/catch that NEVER throws (mirrors campaign-alerts-worker);
// per-cell failures are isolated inside refreshAllResearch (mark stale, continue),
// so a flaky fetch never blocks anything and never wipes last-good content.
// ============================================================================

import cron from "node-cron";
import { env } from "../config/env";
import { refreshAllResearch } from "../services/cac-research.service";

const CRON_EXPRESSION = "0 6 * * 1"; // weekly — Mondays 06:00 (server UTC)
let running = false;

async function runOnce(reason: string): Promise<void> {
  if (running) return;
  running = true;
  try {
    const { refreshed, failed, skipped } = await refreshAllResearch(reason);
    console.log(`[cac-research] ${reason}: refreshed ${refreshed}, failed ${failed}, skipped ${skipped}`);
  } catch (e) {
    console.error("[cac-research] refresh failed:", (e as Error).message);
  } finally {
    running = false;
  }
}

export function startCacResearchWorker(): void {
  if (env.CAC_RESEARCH_ENABLED !== "true") {
    console.log("[cac-research] DISABLED — set CAC_RESEARCH_ENABLED=true to enable the live web-research layer");
    return;
  }
  if (process.env.DISABLE_CAC_RESEARCH_CRON === "true") {
    console.log("[cac-research] cron DISABLED via DISABLE_CAC_RESEARCH_CRON");
    return;
  }
  if (!cron.validate(CRON_EXPRESSION)) {
    console.error(`[cac-research] invalid schedule: ${CRON_EXPRESSION}`);
    return;
  }
  cron.schedule(CRON_EXPRESSION, () => {
    void runOnce("weekly-refresh");
  });
  console.log("[cac-research] cron scheduled weekly (Mon 06:00 UTC)");
}
