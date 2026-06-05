// ============================================================================
// EMAIL QUERY / COMPOSE / BEST-SEND-TIME — Sprint 10 (Phases D + E)
// ============================================================================

import { prisma } from "../config/database";
import { notFound, badRequest } from "../middleware/errorHandler";
import { sendTrackedEmail } from "./email-tracking.service";

function safeMeta(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

// One contact's email timeline: each message + its events + open/click counts.
export async function listContactEmails(companyId: string, contactId: string) {
  const messages = await prisma.emailMessage.findMany({
    where: { companyId, contactId },
    orderBy: { sentAt: "desc" },
    take: 100,
  });
  if (messages.length === 0) return { messages: [] };
  const ids = messages.map((m) => m.id);
  const events = await prisma.emailEvent.findMany({
    where: { emailId: { in: ids } },
    orderBy: { createdAt: "asc" },
  });
  const byEmail = new Map<string, typeof events>();
  for (const e of events) {
    const arr = byEmail.get(e.emailId) ?? [];
    arr.push(e);
    byEmail.set(e.emailId, arr);
  }
  return {
    messages: messages.map((m) => {
      const evs = byEmail.get(m.id) ?? [];
      return {
        ...m,
        opens: evs.filter((e) => e.type === "open").length,
        clicks: evs.filter((e) => e.type === "click").length,
        events: evs.map((e) => ({ id: e.id, type: e.type, meta: safeMeta(e.meta), createdAt: e.createdAt })),
      };
    }),
  };
}

export async function getEmail(companyId: string, id: string) {
  const msg = await prisma.emailMessage.findFirst({ where: { id, companyId } });
  if (!msg) throw notFound("Email");
  const events = await prisma.emailEvent.findMany({
    where: { emailId: id },
    orderBy: { createdAt: "asc" },
  });
  return {
    ...msg,
    events: events.map((e) => ({ id: e.id, type: e.type, meta: safeMeta(e.meta), createdAt: e.createdAt })),
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Plain-text compose body → minimal branded HTML (links auto-rewritten + pixel
// injected downstream by sendTrackedEmail).
function bodyToHtml(body: string): string {
  const safe = escapeHtml(body).replace(/\n/g, "<br>");
  const linked = safe.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  return `<!DOCTYPE html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;color:#0F172A;font-size:15px;line-height:1.6;"><div>${linked}</div></body></html>`;
}

export interface ComposeInput {
  contactId: string;
  subject: string;
  body: string;
}

export async function composeAndSend(companyId: string, userId: string, dto: ComposeInput) {
  const contact = await prisma.customer.findFirst({
    where: { id: dto.contactId, companyId },
    select: { id: true, email: true },
  });
  if (!contact) throw notFound("Contact");
  if (!contact.email) throw badRequest("This contact has no email address");

  const r = await sendTrackedEmail({
    companyId,
    contactId: contact.id,
    userId,
    to: contact.email,
    subject: dto.subject,
    html: bodyToHtml(dto.body),
    text: dto.body,
  });
  if (!r.ok) throw badRequest("Email failed to send — check Resend configuration");
  return r.emailId ? getEmail(companyId, r.emailId) : { ok: true };
}

// Best send time from the contact's open histogram. Null under 3 opens (honesty
// over guessing). Hours computed in Europe/Istanbul (the app's display tz).
const TZ_OFFSET_HOURS = 3; // Europe/Istanbul (UTC+3, no DST)

export async function bestSendTime(
  companyId: string,
  contactId: string
): Promise<{ hourRange: string; confidence: number } | null> {
  const msgs = await prisma.emailMessage.findMany({
    where: { companyId, contactId },
    select: { id: true },
  });
  if (msgs.length === 0) return null;
  const opens = await prisma.emailEvent.findMany({
    where: { emailId: { in: msgs.map((m) => m.id) }, type: "open" },
    select: { createdAt: true },
  });
  if (opens.length < 3) return null;

  const hist = new Array(24).fill(0);
  for (const o of opens) {
    const h = (o.createdAt.getUTCHours() + TZ_OFFSET_HOURS) % 24;
    hist[h]++;
  }
  // Best 2-hour window.
  let bestStart = 0;
  let bestSum = -1;
  for (let h = 0; h < 24; h++) {
    const sum = hist[h] + hist[(h + 1) % 24];
    if (sum > bestSum) {
      bestSum = sum;
      bestStart = h;
    }
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  const end = (bestStart + 2) % 24;
  return {
    hourRange: `${pad(bestStart)}:00-${pad(end)}:00`,
    confidence: Math.round((bestSum / opens.length) * 100) / 100,
  };
}
