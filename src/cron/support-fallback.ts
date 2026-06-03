// ============================================================================
// SUPPORT — EMAIL FALLBACK CRON
// ----------------------------------------------------------------------------
// When a chat has been awaiting_human longer than SUPPORT_FALLBACK_MINUTES and
// no human has replied, post an apology system message + email the customer
// "we'll reply by email shortly". Dedupe via fallbackSentAt. Thread stays open
// for async reply. Best-effort — never throws into the loop.
// ============================================================================

import { env } from "../config/env";
import {
  findStaleEscalations,
  appendMessage,
  markFallbackSent,
} from "../services/support/conversation";
import { sendFallbackEmail } from "../services/support/email";

const CHECK_INTERVAL_MS = 60 * 1000; // sweep once a minute

const FALLBACK_LINE =
  "Thanks for reaching out — our team will reply to you by email shortly. We're sorry for any delay due to high volume.";

async function sweep(): Promise<void> {
  try {
    const stale = await findStaleEscalations(env.SUPPORT_FALLBACK_MINUTES);
    for (const conv of stale) {
      try {
        await appendMessage(conv.id, "system", FALLBACK_LINE);
        if (conv.contactEmail) {
          void sendFallbackEmail({ to: conv.contactEmail, locale: "en" });
        }
        await markFallbackSent(conv.id);
      } catch (err) {
        console.error("[support-fallback] item failed (non-fatal):", (err as Error).message);
      }
    }
  } catch (err) {
    console.error("[support-fallback] sweep failed (non-fatal):", (err as Error).message);
  }
}

export function startSupportFallbackCron(): void {
  setInterval(() => {
    void sweep();
  }, CHECK_INTERVAL_MS);
  console.log("[support-fallback] cron started (window:", env.SUPPORT_FALLBACK_MINUTES, "min)");
}
