// ============================================================================
// RESEND INBOUND — email replies (Sprint 15C)
// ----------------------------------------------------------------------------
// Resend forwards parsed inbound emails (to r+<token>@REPLY_DOMAIN) to our
// webhook. We extract the token, match the original outbound email_messages row
// (by trackToken), store the reply as a direction='in' row, stamp repliedAt on
// the original, log a 'reply' email_event, and return context so the route can
// fire email.replied + cadence auto-exit. Idempotent on the inbound provider id.
// ============================================================================

import { prisma } from "../config/database";
import { env } from "../config/env";
import { ensureTicketForInbound } from "./ticket.service";

export interface InboundReplyResult {
  matched: boolean;
  companyId: string | null;
  contactId: string | null;
  originalEmailId: string | null;
  inboundEmailId: string | null;
  replyText: string;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// Strip quoted history so the AI/preview see the customer's actual reply.
function topReply(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (/^>/.test(line) || /^On .+wrote:$/.test(line.trim()) || /^-{2,}\s*Original Message/i.test(line)) break;
    out.push(line);
  }
  return out.join("\n").trim() || text.trim();
}

// Pull every candidate recipient string out of a Resend inbound payload, which
// may shape `to` as a string, an array of strings, or {address}/{email} objects.
function collectRecipients(data: any): string[] {
  const acc: string[] = [];
  const push = (v: unknown) => {
    if (!v) return;
    if (typeof v === "string") acc.push(v);
    else if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.address === "string") acc.push(o.address);
      if (typeof o.email === "string") acc.push(o.email);
    }
  };
  for (const key of ["to", "recipient", "recipients", "envelope_to"]) {
    const val = data?.[key];
    if (Array.isArray(val)) val.forEach(push);
    else push(val);
  }
  return acc;
}

export function extractReplyToken(data: any): string | null {
  const domain = env.REPLY_DOMAIN.replace(/\./g, "\\.");
  const re = new RegExp(`r\\+([a-zA-Z0-9]+)@${domain}`, "i");
  for (const r of collectRecipients(data)) {
    const m = r.match(re);
    if (m) return m[1];
  }
  return null;
}

export async function processInboundReply(payload: any): Promise<InboundReplyResult> {
  const empty: InboundReplyResult = {
    matched: false, companyId: null, contactId: null,
    originalEmailId: null, inboundEmailId: null, replyText: "",
  };
  const data = payload?.data ?? payload ?? {};

  const token = extractReplyToken(data);
  if (!token) return empty;

  const original = await prisma.emailMessage.findUnique({
    where: { trackToken: token },
    select: { id: true, companyId: true, contactId: true, subject: true, repliedAt: true },
  });
  if (!original) return empty;

  const inboundProviderId =
    (typeof data.email_id === "string" && data.email_id) ||
    (typeof data.message_id === "string" && data.message_id) ||
    (typeof data.id === "string" && data.id) ||
    null;

  // Idempotency — skip if we already stored this inbound message.
  if (inboundProviderId) {
    const dup = await prisma.emailMessage.findFirst({
      where: { providerId: inboundProviderId, direction: "in" },
      select: { id: true },
    });
    if (dup) {
      return {
        matched: true, companyId: original.companyId, contactId: original.contactId,
        originalEmailId: original.id, inboundEmailId: dup.id, replyText: "",
      };
    }
  }

  const rawText =
    (typeof data.text === "string" && data.text) ||
    (typeof data.html === "string" && stripHtml(data.html)) ||
    "";
  const replyText = topReply(rawText).slice(0, 20000);
  const subject = typeof data.subject === "string" ? data.subject.slice(0, 500) : original.subject;

  const inbound = await prisma.emailMessage.create({
    data: {
      companyId: original.companyId,
      contactId: original.contactId,
      direction: "in",
      subject,
      bodyPreview: replyText.slice(0, 280),
      body: replyText,
      providerId: inboundProviderId,
      replyToMessageId: original.id,
      status: "delivered",
    },
    select: { id: true },
  });

  if (!original.repliedAt) {
    await prisma.emailMessage.update({ where: { id: original.id }, data: { repliedAt: new Date() } });
  }
  await prisma.emailEvent.create({
    data: { emailId: original.id, type: "reply", meta: JSON.stringify({ inboundEmailId: inbound.id }) },
  });

  // Service desk: an inbound email reply outside an open ticket → ticket
  // (inert unless the desk is enabled for the company).
  void ensureTicketForInbound({
    companyId: original.companyId,
    channel: "email",
    customerId: original.contactId,
    emailMessageId: inbound.id,
    subject: subject ?? null,
  });

  return {
    matched: true,
    companyId: original.companyId,
    contactId: original.contactId,
    originalEmailId: original.id,
    inboundEmailId: inbound.id,
    replyText,
  };
}
