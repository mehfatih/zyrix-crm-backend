// ============================================================================
// EMAIL EVENT BRIDGE — Sprint 10
// ----------------------------------------------------------------------------
// Translates recorded tracking results into Automation Engine emits. Kept
// separate from email-tracking.service so the public pixel/click routes stay
// dependency-light and the emit is fire-and-forget.
// ============================================================================

import type { OpenResult, ClickResult } from "./email-tracking.service";
import type { ResendEventResult } from "./resend-webhook.service";
import {
  dispatchEmailOpened,
  dispatchEmailClicked,
  dispatchEmailBounced,
} from "./workflow-events.service";

export async function onEmailOpened(r: OpenResult): Promise<void> {
  // Only emit on a genuinely-new open (deduped re-fetches don't fire).
  if (!r.recorded || !r.companyId || !r.emailId) return;
  await dispatchEmailOpened(r.companyId, {
    emailId: r.emailId,
    customerId: r.contactId,
    openCount: r.openCount,
    firstOpen: r.firstOpen,
  });
}

export async function onEmailClicked(r: ClickResult, url: string): Promise<void> {
  if (!r.found || !r.companyId || !r.emailId) return;
  await dispatchEmailClicked(r.companyId, {
    emailId: r.emailId,
    customerId: r.contactId,
    url: url.slice(0, 500),
  });
}

export async function onEmailBounced(r: ResendEventResult): Promise<void> {
  if (!r.bounced || !r.companyId || !r.emailId) return;
  await dispatchEmailBounced(r.companyId, {
    emailId: r.emailId,
    customerId: r.contactId,
  });
}
