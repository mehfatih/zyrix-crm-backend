// ============================================================================
// DATA RETENTION CRON (P5)
// ----------------------------------------------------------------------------
// Runs every day at 03:17 UTC (off-peak, dodges other cron collisions).
// Deletes rows older than the per-company retention policy; legal hold
// short-circuits the whole row by setting policy.legalHold = true.
// ============================================================================

import cron from "node-cron";
import { runRetentionPass } from "../services/retention.service";

let started = false;

export function startRetentionCron(): void {
  if (started) return;
  started = true;

  // Pattern: 17 3 * * *  =  03:17 every day, server time (UTC on Railway).
  cron.schedule("17 3 * * *", async () => {
    const startedAt = Date.now();
    try {
      const results = await runRetentionPass();
      const totalDeleted = results.reduce((a, r) => a + r.deleted, 0);
      const ms = Date.now() - startedAt;
      console.log(
        `[retention] pass complete in ${ms}ms — ${results.length} policies, ${totalDeleted} rows deleted`
      );
    } catch (err) {
      console.error("[retention] pass failed:", err);
    }
  });
  console.log("[retention] daily cron scheduled for 03:17 UTC");
}
