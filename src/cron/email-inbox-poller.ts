// ============================================================================
// EMAIL INBOX POLLER (Sprint 15D)
// Every 5 minutes, poll each active connected inbox (Gmail/IMAP) for new mail
// matching known contacts. Per-connection isolation lives in pollConnection.
// DISABLE_INBOX_POLLER=true opts out.
// ============================================================================

import cron from "node-cron";
import { pollAllInboxes } from "../services/email-inbox.service";

const CRON_EXPRESSION = "*/5 * * * *"; // every 5 minutes

let running = false;

export function startEmailInboxPoller(): void {
  if (process.env.DISABLE_INBOX_POLLER === "true") {
    console.log("[inbox-poller] DISABLED via DISABLE_INBOX_POLLER");
    return;
  }
  if (!cron.validate(CRON_EXPRESSION)) {
    console.error(`[inbox-poller] invalid schedule: ${CRON_EXPRESSION}`);
    return;
  }
  cron.schedule(CRON_EXPRESSION, async () => {
    if (running) return;
    running = true;
    try {
      const { polled } = await pollAllInboxes();
      if (polled) console.log(`[inbox-poller] polled ${polled} inbox(es)`);
    } catch (e) {
      console.error("[inbox-poller] run failed:", (e as Error).message);
    } finally {
      running = false;
    }
  });
  console.log("[inbox-poller] scheduled every 5 min");
}
