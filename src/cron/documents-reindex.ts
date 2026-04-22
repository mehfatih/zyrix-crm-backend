// ============================================================================
// WEEKLY DOCUMENT RE-INDEX (P9)
// ----------------------------------------------------------------------------
// Refreshes every DocumentLink's title + snippet once per week so edits in
// Google Drive propagate into the CRM UI without requiring the user to
// re-attach the doc.
// ============================================================================

import cron from "node-cron";
import { reindexAllDocuments } from "../services/documents.service";

let started = false;

export function startDocumentsReindexCron(): void {
  if (started) return;
  started = true;

  // Every Sunday at 04:13 UTC — off-peak, doesn't collide with the
  // 03:17 retention cron.
  cron.schedule("13 4 * * 0", async () => {
    try {
      const { updated, checked } = await reindexAllDocuments();
      console.log(
        `[docs-reindex] pass complete — ${updated}/${checked} updated`
      );
    } catch (err) {
      console.error("[docs-reindex] pass failed:", err);
    }
  });
  console.log("[docs-reindex] weekly cron scheduled for Sunday 04:13 UTC");
}
