// ============================================================================
// RESEND WEBHOOK — Sprint 10
// ----------------------------------------------------------------------------
// Receives Resend's Svix-signed events and updates delivery status. We rely on
// OUR pixel + wrapped links for open/click (source of truth), so Resend's
// opened/clicked events are intentionally ignored to avoid double-counting.
// Only delivered / bounced / complained are consumed here.
// ============================================================================

import crypto from "crypto";
import { prisma } from "../config/database";
import { env } from "../config/env";
import { recordIntegrationEvent } from "./integration-events.service";

// Verify a Svix signature (the scheme Resend uses).
// Header set: svix-id, svix-timestamp, svix-signature ("v1,<b64> v1,<b64>").
// Secret: "whsec_<base64>" — sign base64-decoded key over `${id}.${ts}.${body}`.
export function verifyResendSignature(
  rawBody: Buffer,
  headers: Record<string, string | undefined>,
  // Sprint 15C — overridable so the inbound receiver can use its own secret.
  secret: string | undefined = env.RESEND_WEBHOOK_SECRET
): boolean {
  if (!secret) return false;
  const id = headers["svix-id"];
  const ts = headers["svix-timestamp"];
  const sigHeader = headers["svix-signature"];
  if (!id || !ts || !sigHeader) return false;

  // Replay guard: reject timestamps older/newer than 5 minutes.
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) return false;

  const keyB64 = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  let keyBytes: Buffer;
  try {
    keyBytes = Buffer.from(keyB64, "base64");
  } catch {
    return false;
  }
  const signedContent = `${id}.${ts}.${rawBody.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", keyBytes).update(signedContent).digest("base64");
  const expectedBuf = Buffer.from(expected);

  // Header may carry multiple space-separated "v1,<sig>" pairs.
  for (const part of sigHeader.split(" ")) {
    const sig = part.includes(",") ? part.split(",")[1] : part;
    const sigBuf = Buffer.from(sig || "");
    if (sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return true;
    }
  }
  return false;
}

export interface ResendEventResult {
  handled: boolean;
  emailId: string | null;
  companyId: string | null;
  contactId: string | null;
  bounced: boolean;
}

// Update status + record events from a verified Resend event payload.
export async function processResendEvent(payload: {
  type?: string;
  data?: { email_id?: string };
}): Promise<ResendEventResult> {
  const none: ResendEventResult = { handled: false, emailId: null, companyId: null, contactId: null, bounced: false };
  const type = payload?.type ?? "";
  const providerId = payload?.data?.email_id;
  if (!providerId) return none;

  const msg = await prisma.emailMessage.findFirst({
    where: { providerId },
    select: { id: true, companyId: true, contactId: true },
  });
  if (!msg) return none; // not a tracked CRM email (or system email) — ignore

  const ctx = { emailId: msg.id, companyId: msg.companyId, contactId: msg.contactId };

  if (type === "email.delivered") {
    await prisma.emailMessage.update({ where: { id: msg.id }, data: { status: "delivered" } });
    return { handled: true, ...ctx, bounced: false };
  }
  if (type === "email.bounced") {
    await prisma.emailMessage.update({ where: { id: msg.id }, data: { status: "bounced" } });
    await prisma.emailEvent.create({ data: { emailId: msg.id, type: "bounce", meta: JSON.stringify({ source: "resend" }) } });
    return { handled: true, ...ctx, bounced: true };
  }
  if (type === "email.complained") {
    await prisma.emailEvent.create({ data: { emailId: msg.id, type: "complaint", meta: JSON.stringify({ source: "resend" }) } });
    return { handled: true, ...ctx, bounced: false };
  }
  // email.sent / email.opened / email.clicked / email.delivery_delayed → ignore.
  return { handled: false, ...ctx, bounced: false };
}

export function logResendWebhook(companyId: string | null, type: string, ok: boolean): void {
  recordIntegrationEvent({
    companyId,
    platform: "resend",
    eventType: ok ? "webhook_received" : "webhook_failed",
    requestContext: { type },
  });
}
