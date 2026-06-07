// ============================================================================
// CALENDAR POLLER (Sprint 21)
// Every 5 minutes, incrementally poll each connected Google Calendar for events
// matching known contacts. Per-connection isolation lives in
// pollCalendarConnection. DISABLE_CALENDAR_POLLER=true opts out.
// ============================================================================

import cron from "node-cron";
import { pollAllCalendars } from "../services/calendar-sync.service";

const CRON_EXPRESSION = "*/5 * * * *"; // every 5 minutes

let running = false;

export function startCalendarPoller(): void {
  if (process.env.DISABLE_CALENDAR_POLLER === "true") {
    console.log("[calendar-poller] DISABLED via DISABLE_CALENDAR_POLLER");
    return;
  }
  if (!cron.validate(CRON_EXPRESSION)) {
    console.error(`[calendar-poller] invalid schedule: ${CRON_EXPRESSION}`);
    return;
  }
  cron.schedule(CRON_EXPRESSION, async () => {
    if (running) return;
    running = true;
    try {
      const { polled } = await pollAllCalendars();
      if (polled) console.log(`[calendar-poller] polled ${polled} calendar(s)`);
    } catch (e) {
      console.error("[calendar-poller] run failed:", (e as Error).message);
    } finally {
      running = false;
    }
  });
  console.log("[calendar-poller] scheduled every 5 min");
}
