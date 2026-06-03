// ============================================================================
// SUPPORT — ESCALATION NOTIFY (email always, Slack if webhook configured)
// ----------------------------------------------------------------------------
// Pings the Zyrix team when a chat escalates to awaiting_human. Both channels
// are optional and best-effort — never throws, never blocks the escalation.
// ============================================================================

import { env } from "../../config/env";
import { sendEmail } from "../email.service";

export async function notifyEscalation(params: {
  conversationId: string;
  companyId: string;
  contactEmail: string | null;
  subject: string | null;
  lastUserMessage: string | null;
}): Promise<void> {
  const summary = params.subject || params.lastUserMessage || "(no message)";
  const line = `New support escalation — company ${params.companyId}, conversation ${params.conversationId}. ${
    params.contactEmail ? `Contact: ${params.contactEmail}. ` : ""
  }Topic: ${summary}`;

  // Email to the Zyrix support inbox (best-effort).
  if (env.SUPPORT_NOTIFY_EMAIL) {
    try {
      await sendEmail({
        to: env.SUPPORT_NOTIFY_EMAIL,
        subject: `🔔 Support escalation — ${summary.slice(0, 60)}`,
        html: `<p>${line.replace(/</g, "&lt;")}</p><p>Open it in the Zyrix Support Console.</p>`,
      });
    } catch {
      /* best-effort */
    }
  }

  // Slack (best-effort) if a webhook is configured.
  if (env.SUPPORT_SLACK_WEBHOOK_URL) {
    try {
      await fetch(env.SUPPORT_SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `🔔 ${line}` }),
      });
    } catch {
      /* best-effort */
    }
  }
}
