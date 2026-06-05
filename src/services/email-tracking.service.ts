// ============================================================================
// EMAIL TRACKING — Sprint 10
// ----------------------------------------------------------------------------
// `sendTrackedEmail` is the ONLY tracked send path (CRM user → contact). System
// / auth / support emails keep calling the plain `sendEmail` and are never
// instrumented. When the company's emailTrackingEnabled toggle is off, the
// message is still logged (so the contact email timeline works) but NO pixel /
// link rewriting happens — a clean untracked send.
//
// Open  = our 1×1 pixel  GET /api/t/o/:token
// Click = our wrapped + HMAC-signed link  GET /api/t/c/:token?u=<b64url>&s=<sig>
// (Delivered / bounced come from the Resend webhook, by providerId — Phase B.)
// ============================================================================

import crypto from "crypto";
import { prisma } from "../config/database";
import { env } from "../config/env";
import { sendEmailRaw, type SendEmailOptions } from "./email.service";
import { bumpStepStat } from "./cadence.service";

const BASE = (env.EMAIL_TRACKING_BASE_URL || "https://api.crm.zyrix.co").replace(/\/$/, "");
const SIGN_SECRET = env.JWT_ACCESS_SECRET || "zyrix-email-track-fallback";
const OPEN_DEDUPE_MS = 10 * 60 * 1000;

// 1×1 transparent GIF.
const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);
export function trackingPixel(): Buffer {
  return PIXEL;
}

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
export const fromB64url = (s: string) => Buffer.from(s, "base64url").toString("utf8");

function sign(token: string, payload: string): string {
  return crypto.createHmac("sha256", SIGN_SECRET).update(`${token}:${payload}`).digest("base64url");
}
export function verifyClickSig(token: string, payload: string, sig: string): boolean {
  const expected = sign(token, payload);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig || "");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function visitorHash(ip: string, ua: string): string {
  return crypto.createHash("sha256").update(`${ip}|${ua}`).digest("hex").slice(0, 32);
}

// Rewrite http(s) anchor hrefs → signed tracked redirect; inject the open pixel.
function instrumentHtml(html: string, token: string): string {
  const rewritten = html.replace(/href\s*=\s*"(https?:\/\/[^"]+)"/gi, (_m, url: string) => {
    const u = b64url(url);
    // Use &amp; (not raw &) so email-client HTML sanitizers (Gmail) don't drop
    // the signature param — it renders back to & in the live link.
    return `href="${BASE}/api/t/c/${token}?u=${u}&amp;s=${sign(token, u)}"`;
  });
  const pixel = `<img src="${BASE}/api/t/o/${token}" width="1" height="1" alt="" style="display:none" />`;
  return rewritten.includes("</body>")
    ? rewritten.replace("</body>", `${pixel}</body>`)
    : rewritten + pixel;
}

function textPreview(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

export interface TrackedEmailInput {
  companyId: string;
  contactId?: string | null;
  userId?: string | null;
  to: string;
  subject: string;
  html: string;
  text?: string;
  attachments?: SendEmailOptions["attachments"];
  // Sprint 11 — cadence step attribution (opens/clicks roll up to the step).
  cadenceId?: string | null;
  cadenceStepIndex?: number | null;
}

export async function sendTrackedEmail(
  input: TrackedEmailInput
): Promise<{ ok: boolean; emailId: string | null; providerId: string | null }> {
  const company = await prisma.company.findUnique({
    where: { id: input.companyId },
    select: { emailTrackingEnabled: true },
  });
  const tracking = company?.emailTrackingEnabled !== false;
  const token = tracking ? crypto.randomBytes(18).toString("hex") : null;
  const html = token ? instrumentHtml(input.html, token) : input.html;

  const sent = await sendEmailRaw({
    to: input.to,
    subject: input.subject,
    html,
    text: input.text,
    attachments: input.attachments,
  });

  let emailId: string | null = null;
  try {
    const row = await prisma.emailMessage.create({
      data: {
        companyId: input.companyId,
        contactId: input.contactId ?? null,
        userId: input.userId ?? null,
        direction: "out",
        subject: input.subject ?? null,
        bodyPreview: textPreview(input.text || input.html),
        providerId: sent.id,
        trackToken: token,
        status: "sent", // delivered / bounced arrive via the Resend webhook
        cadenceId: input.cadenceId ?? null,
        cadenceStepIndex: input.cadenceStepIndex ?? null,
      },
      select: { id: true },
    });
    emailId = row.id;
  } catch (e) {
    console.error("[email-track] record failed (non-fatal):", (e as Error).message);
  }
  return { ok: sent.ok, emailId, providerId: sent.id };
}

// ── Event recording (called by the public pixel / click routes) ─────────────
// Returns context so callers (Phase C) can emit automation events. Never throws.
export interface OpenResult {
  found: boolean;
  recorded: boolean; // a new open event was inserted (false when deduped)
  firstOpen: boolean;
  emailId: string | null;
  companyId: string | null;
  contactId: string | null;
  openCount: number;
}

export async function recordOpen(token: string, vhash: string, ua: string): Promise<OpenResult> {
  const none: OpenResult = { found: false, recorded: false, firstOpen: false, emailId: null, companyId: null, contactId: null, openCount: 0 };
  try {
    const msg = await prisma.emailMessage.findUnique({
      where: { trackToken: token },
      select: { id: true, companyId: true, contactId: true, cadenceId: true, cadenceStepIndex: true },
    });
    if (!msg) return none;

    // Dedupe: skip a repeat open from the same visitor within the window.
    const since = new Date(Date.now() - OPEN_DEDUPE_MS);
    const recent = await prisma.emailEvent.findFirst({
      where: { emailId: msg.id, type: "open", createdAt: { gte: since }, meta: { contains: vhash } },
      select: { id: true },
    });
    const priorOpens = await prisma.emailEvent.count({ where: { emailId: msg.id, type: "open" } });
    if (recent) {
      return { found: true, recorded: false, firstOpen: false, emailId: msg.id, companyId: msg.companyId, contactId: msg.contactId, openCount: priorOpens };
    }
    await prisma.emailEvent.create({
      data: { emailId: msg.id, type: "open", meta: JSON.stringify({ v: vhash, ua: ua.slice(0, 200) }) },
    });
    // Cadence step stat: count a unique open once (on first open).
    if (priorOpens === 0 && msg.cadenceId && msg.cadenceStepIndex != null) {
      void bumpStepStat(msg.cadenceId, msg.cadenceStepIndex, "opened");
    }
    return {
      found: true,
      recorded: true,
      firstOpen: priorOpens === 0,
      emailId: msg.id,
      companyId: msg.companyId,
      contactId: msg.contactId,
      openCount: priorOpens + 1,
    };
  } catch (e) {
    console.error("[email-track] recordOpen failed (non-fatal):", (e as Error).message);
    return none;
  }
}

export interface ClickResult {
  found: boolean;
  emailId: string | null;
  companyId: string | null;
  contactId: string | null;
}

export async function recordClick(token: string, url: string, vhash: string, ua: string): Promise<ClickResult> {
  const none: ClickResult = { found: false, emailId: null, companyId: null, contactId: null };
  try {
    const msg = await prisma.emailMessage.findUnique({
      where: { trackToken: token },
      select: { id: true, companyId: true, contactId: true, cadenceId: true, cadenceStepIndex: true },
    });
    if (!msg) return none;
    const priorClicks = await prisma.emailEvent.count({ where: { emailId: msg.id, type: "click" } });
    await prisma.emailEvent.create({
      data: { emailId: msg.id, type: "click", meta: JSON.stringify({ url: url.slice(0, 500), v: vhash, ua: ua.slice(0, 200) }) },
    });
    // Cadence step stat: count a unique click once (on first click).
    if (priorClicks === 0 && msg.cadenceId && msg.cadenceStepIndex != null) {
      void bumpStepStat(msg.cadenceId, msg.cadenceStepIndex, "clicked");
    }
    return { found: true, emailId: msg.id, companyId: msg.companyId, contactId: msg.contactId };
  } catch (e) {
    console.error("[email-track] recordClick failed (non-fatal):", (e as Error).message);
    return none;
  }
}
