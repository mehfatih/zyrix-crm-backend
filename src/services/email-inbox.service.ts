// ============================================================================
// EMAIL INBOX CONNECT (Sprint 15D) — Gmail OAuth (gmail.readonly) + IMAP.
// ----------------------------------------------------------------------------
// READ-ONLY v1: poll a connected inbox every 5 min, match messages to known
// contacts by email, store them in the contact Email tab timeline. Matched
// inbound fires email.replied + cadence auto-exit (deduped by Message-ID).
// Connected-inbox mail is UNTRACKED (no pixel/links) — tracking stays Resend-only.
// Creds are tokenCipher-sealed. Gmail uses a SEPARATE OAuth flow/scope/callback
// so the existing non-sensitive drive.file flow is untouched.
// ============================================================================

import { google } from "googleapis";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import jwt from "jsonwebtoken";
import { prisma } from "../config/database";
import { env } from "../config/env";
import { getClientId, getClientSecret } from "./google/config";
import { encryptToken, decryptToken, type SealedToken } from "../lib/crypto/tokenCipher";
import { badRequest } from "../middleware/errorHandler";
import { integrationError } from "../lib/errors/integrationErrors";
import { isFeatureEnabled } from "./feature-flags.service";
import { dispatchEmailReplied } from "./workflow-events.service";
import { onContactReplied } from "./cadence.service";
import { recordIntegrationEvent } from "./integration-events.service";

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "openid",
  "email",
  "profile",
];

function seal(plaintext: string): string {
  return JSON.stringify(encryptToken(plaintext));
}
function unseal(text: string): string {
  return decryptToken(JSON.parse(text) as SealedToken);
}
function normEmail(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

// ── Gmail OAuth (separate client bound to the inbox redirect) ───────────────
function gmailOAuthClient() {
  const clientId = getClientId();
  const clientSecret = getClientSecret();
  if (!clientId || !clientSecret) {
    throw integrationError("GOOGLE_NOT_CONFIGURED", "Google OAuth credentials are not configured", { platform: "google" });
  }
  return new google.auth.OAuth2(clientId, clientSecret, env.EMAIL_INBOX_GOOGLE_REDIRECT_URI);
}

export function buildGmailAuthUrl(companyId: string, userId: string): string {
  const state = jwt.sign({ companyId, userId, p: "email_inbox" }, env.JWT_ACCESS_SECRET, { expiresIn: "10m" });
  return gmailOAuthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GMAIL_SCOPES,
    include_granted_scopes: true,
    state,
  });
}

export async function completeGmailConnect(code: string, state: string): Promise<{ emailAddress: string }> {
  let claims: { companyId?: string; userId?: string; p?: string };
  try {
    claims = jwt.verify(state, env.JWT_ACCESS_SECRET) as typeof claims;
  } catch {
    throw badRequest("Invalid or expired OAuth state");
  }
  if (!claims.companyId || !claims.userId || claims.p !== "email_inbox") throw badRequest("Bad OAuth state");

  const client = gmailOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw badRequest("Google did not return a refresh token — remove the app under your Google account's third-party access and reconnect.");
  }
  client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: "v2", auth: client });
  const me = await oauth2.userinfo.get();
  const emailAddress = normEmail(me.data.email);
  if (!emailAddress) throw badRequest("Could not read the Google account email");

  await prisma.emailInboxConnection.upsert({
    where: { companyId_userId_provider_emailAddress: { companyId: claims.companyId, userId: claims.userId, provider: "gmail", emailAddress } },
    create: {
      companyId: claims.companyId, userId: claims.userId, provider: "gmail", emailAddress,
      sealedCreds: seal(JSON.stringify({ refreshToken: tokens.refresh_token })), status: "active",
    },
    update: { sealedCreds: seal(JSON.stringify({ refreshToken: tokens.refresh_token })), status: "active", lastError: null },
  });
  return { emailAddress };
}

// ── IMAP connect (verify by actually connecting) ────────────────────────────
export interface ImapCreds {
  host: string;
  port: number;
  user: string;
  appPassword: string;
  tls?: boolean;
}

export async function connectImap(companyId: string, userId: string, creds: ImapCreds): Promise<{ emailAddress: string }> {
  const client = new ImapFlow({
    host: creds.host, port: creds.port, secure: creds.tls !== false,
    auth: { user: creds.user, pass: creds.appPassword }, logger: false,
  });
  try {
    await client.connect();
    await client.logout();
  } catch (e) {
    throw badRequest(`IMAP connection failed: ${(e as Error).message}`);
  }
  const emailAddress = normEmail(creds.user);
  await prisma.emailInboxConnection.upsert({
    where: { companyId_userId_provider_emailAddress: { companyId, userId, provider: "imap", emailAddress } },
    create: { companyId, userId, provider: "imap", emailAddress, sealedCreds: seal(JSON.stringify(creds)), status: "active" },
    update: { sealedCreds: seal(JSON.stringify(creds)), status: "active", lastError: null },
  });
  return { emailAddress };
}

// ── CRUD ─────────────────────────────────────────────────────────────────────
export async function listConnections(companyId: string) {
  const rows = await prisma.emailInboxConnection.findMany({
    where: { companyId },
    select: { id: true, userId: true, provider: true, emailAddress: true, status: true, lastError: true, lastSyncAt: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  return rows;
}

export async function disconnect(companyId: string, id: string): Promise<void> {
  await prisma.emailInboxConnection.deleteMany({ where: { id, companyId } });
}

// ── Polling ──────────────────────────────────────────────────────────────────
interface ParsedMsg {
  messageId: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  date: Date;
}

async function matchAndStore(
  conn: { id: string; companyId: string; userId: string; emailAddress: string },
  msg: ParsedMsg
): Promise<void> {
  if (!msg.messageId) return;
  // Idempotent across polls (and vs Phase C) on the RFC Message-ID.
  const dup = await prisma.emailMessage.findFirst({ where: { companyId: conn.companyId, providerId: msg.messageId }, select: { id: true } });
  if (dup) return;

  const inbound = normEmail(msg.from) !== conn.emailAddress;
  const counterpart = inbound ? normEmail(msg.from) : (msg.to.map(normEmail).find((t) => t && t !== conn.emailAddress) ?? "");
  if (!counterpart) return;

  const customer = await prisma.customer.findFirst({
    where: { companyId: conn.companyId, email: { equals: counterpart, mode: "insensitive" }, deletedAt: null },
    select: { id: true },
  });
  if (!customer) return; // only track mail with known contacts

  const body = msg.text.slice(0, 20000);
  const created = await prisma.emailMessage.create({
    data: {
      companyId: conn.companyId, contactId: customer.id, userId: conn.userId,
      direction: inbound ? "in" : "out", subject: msg.subject.slice(0, 500) || null,
      bodyPreview: body.slice(0, 280), body, providerId: msg.messageId,
      status: inbound ? "delivered" : "sent", sentAt: msg.date,
    },
    select: { id: true },
  });

  if (inbound) {
    void dispatchEmailReplied(conn.companyId, {
      emailId: created.id, customerId: customer.id, replyPreview: body.slice(0, 280), repliedAt: msg.date.toISOString(),
    });
    void onContactReplied(conn.companyId, customer.id);
  }
}

async function pollGmail(conn: { id: string; companyId: string; userId: string; emailAddress: string }, creds: { refreshToken: string }): Promise<number> {
  const client = gmailOAuthClient();
  client.setCredentials({ refresh_token: creds.refreshToken });
  const gmail = google.gmail({ version: "v1", auth: client });
  const list = await gmail.users.messages.list({ userId: "me", q: "newer_than:2d", maxResults: 25 });
  const ids = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);
  let n = 0;
  for (const id of ids) {
    const full = await gmail.users.messages.get({ userId: "me", id, format: "full" });
    const headers = full.data.payload?.headers ?? [];
    const h = (name: string) => headers.find((x) => x.name?.toLowerCase() === name)?.value ?? "";
    const parseAddrs = (s: string) => (s.match(/[^\s<>,;]+@[^\s<>,;]+/g) ?? []);
    const messageId = h("message-id") || `gmail:${id}`;
    const text = decodeGmailBody(full.data.payload) || full.data.snippet || "";
    await matchAndStore(conn, {
      messageId,
      from: parseAddrs(h("from"))[0] ?? "",
      to: parseAddrs(h("to")),
      subject: h("subject"),
      text,
      date: new Date(Number(full.data.internalDate) || Date.now()),
    });
    n++;
  }
  return n;
}

function decodeGmailBody(payload: any): string {
  if (!payload) return "";
  const fromPart = (p: any): string => {
    if (p?.mimeType === "text/plain" && p.body?.data) return Buffer.from(p.body.data, "base64url").toString("utf8");
    if (Array.isArray(p?.parts)) {
      for (const c of p.parts) { const t = fromPart(c); if (t) return t; }
    }
    return "";
  };
  return fromPart(payload).replace(/\r?\n>.*$/gm, "").trim();
}

async function pollImap(conn: { id: string; companyId: string; userId: string; emailAddress: string }, creds: ImapCreds): Promise<number> {
  const client = new ImapFlow({ host: creds.host, port: creds.port, secure: creds.tls !== false, auth: { user: creds.user, pass: creds.appPassword }, logger: false });
  let n = 0;
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const since = new Date(Date.now() - 2 * 86400000);
      for await (const message of client.fetch({ since }, { source: true })) {
        if (!message.source) continue;
        const parsed = await simpleParser(message.source);
        const from = parsed.from?.value?.[0]?.address ?? "";
        const to = (Array.isArray(parsed.to) ? parsed.to : parsed.to ? [parsed.to] : []).flatMap((a) => a.value.map((v) => v.address ?? ""));
        await matchAndStore(conn, {
          messageId: parsed.messageId ?? `imap:${message.uid}`,
          from, to, subject: parsed.subject ?? "",
          text: parsed.text ?? (parsed.html ? String(parsed.html).replace(/<[^>]+>/g, " ") : ""),
          date: parsed.date ?? new Date(),
        });
        n++;
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return n;
}

export async function pollConnection(connId: string): Promise<void> {
  const conn = await prisma.emailInboxConnection.findUnique({ where: { id: connId } });
  if (!conn || conn.status === "disconnected") return;
  try {
    const creds = JSON.parse(unseal(conn.sealedCreds));
    const ctx = { id: conn.id, companyId: conn.companyId, userId: conn.userId, emailAddress: conn.emailAddress };
    const seen = conn.provider === "gmail" ? await pollGmail(ctx, creds) : await pollImap(ctx, creds);
    await prisma.emailInboxConnection.update({ where: { id: conn.id }, data: { lastSyncAt: new Date(), status: "active", lastError: null } });
    recordIntegrationEvent({ companyId: conn.companyId, platform: "email_inbox" as any, eventType: "sync_success", requestContext: { connId: conn.id, provider: conn.provider, seen } });
  } catch (e) {
    await prisma.emailInboxConnection.update({ where: { id: conn.id }, data: { status: "error", lastError: (e as Error).message.slice(0, 400) } }).catch(() => {});
    recordIntegrationEvent({ companyId: conn.companyId, platform: "email_inbox" as any, eventType: "sync_failure", errorMessage: (e as Error).message });
  }
}

// Cron entry — poll every active connection whose company has the feature on.
export async function pollAllInboxes(): Promise<{ polled: number }> {
  const conns = await prisma.emailInboxConnection.findMany({ where: { status: { in: ["active", "error"] } }, select: { id: true, companyId: true } });
  let polled = 0;
  for (const c of conns) {
    if (!(await isFeatureEnabled(c.companyId, "email_inbox"))) continue;
    await pollConnection(c.id);
    polled++;
  }
  return { polled };
}
