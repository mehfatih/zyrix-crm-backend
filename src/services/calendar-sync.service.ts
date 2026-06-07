// ============================================================================
// CALENDAR SYNC (Sprint 21) — Google Calendar two-way sync.
// ----------------------------------------------------------------------------
// SEPARATE OAuth flow from the drive.file (Sprint 5) and gmail.readonly (15D)
// flows: its own scope (calendar.events), its own callback/redirect env, and a
// state-JWT for CSRF — replicating the 15D pattern EXACTLY. The other two Google
// flows are untouched. Refresh tokens are tokenCipher-sealed at rest.
//
// Phase A (this file): connect + CRUD. Outbound push (CRM meeting → Google) and
// the inbound poller (Phase B) are added incrementally below.
// ============================================================================

import crypto from "crypto";
import type { Prisma } from "@prisma/client";
import { google } from "googleapis";
import jwt from "jsonwebtoken";
import { prisma } from "../config/database";
import { env } from "../config/env";
import { getClientId, getClientSecret } from "./google/config";
import { encryptToken, decryptToken, type SealedToken } from "../lib/crypto/tokenCipher";
import { badRequest } from "../middleware/errorHandler";
import { integrationError } from "../lib/errors/integrationErrors";
import { isFeatureEnabled } from "./feature-flags.service";

// calendar.events grants read+write to events on calendars the user owns —
// exactly what two-way sync needs. openid/email/profile give us the connected
// account identity for the UI badge. NEVER widen this to full `calendar`.
const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
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

// ── Calendar OAuth (separate client bound to the calendar redirect) ─────────
function calendarOAuthClient() {
  const clientId = getClientId();
  const clientSecret = getClientSecret();
  if (!clientId || !clientSecret) {
    throw integrationError("GOOGLE_NOT_CONFIGURED", "Google OAuth credentials are not configured", { platform: "google" });
  }
  return new google.auth.OAuth2(clientId, clientSecret, env.CALENDAR_GOOGLE_REDIRECT_URI);
}

export function buildCalendarAuthUrl(companyId: string, userId: string): string {
  const state = jwt.sign({ companyId, userId, p: "calendar" }, env.JWT_ACCESS_SECRET, { expiresIn: "10m" });
  return calendarOAuthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: CALENDAR_SCOPES,
    include_granted_scopes: true,
    state,
  });
}

export async function completeCalendarConnect(code: string, state: string): Promise<{ emailAddress: string }> {
  let claims: { companyId?: string; userId?: string; p?: string };
  try {
    claims = jwt.verify(state, env.JWT_ACCESS_SECRET) as typeof claims;
  } catch {
    throw badRequest("Invalid or expired OAuth state");
  }
  if (!claims.companyId || !claims.userId || claims.p !== "calendar") throw badRequest("Bad OAuth state");

  const client = calendarOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw badRequest("Google did not return a refresh token — remove the app under your Google account's third-party access and reconnect.");
  }
  client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: "v2", auth: client });
  const me = await oauth2.userinfo.get();
  const emailAddress = normEmail(me.data.email);
  if (!emailAddress) throw badRequest("Could not read the Google account email");

  await prisma.calendarConnection.upsert({
    where: { companyId_userId_provider_emailAddress: { companyId: claims.companyId, userId: claims.userId, provider: "google", emailAddress } },
    create: {
      companyId: claims.companyId, userId: claims.userId, provider: "google", emailAddress,
      calendarId: "primary", sealedCreds: seal(JSON.stringify({ refreshToken: tokens.refresh_token })), status: "active",
    },
    update: { sealedCreds: seal(JSON.stringify({ refreshToken: tokens.refresh_token })), status: "active", lastError: null },
  });
  return { emailAddress };
}

// ── CRUD ─────────────────────────────────────────────────────────────────────
export async function listConnections(companyId: string) {
  return prisma.calendarConnection.findMany({
    where: { companyId },
    select: { id: true, userId: true, provider: true, emailAddress: true, calendarId: true, status: true, lastError: true, lastSyncAt: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function disconnect(companyId: string, id: string): Promise<void> {
  await prisma.calendarConnection.deleteMany({ where: { id, companyId } });
}

// ── Outbound: CRM meeting → Google (Phase A) ─────────────────────────────────
// A CRM "meeting" is an Activity with type="meeting". We push when the meeting's
// owner (userId) has an active Google connection, the company has calendar_sync,
// the meeting has a start time (dueDate), and metadata.addToGoogle !== false.
// Everything here is FAILURE-SAFE: callers fire-and-forget; the meeting is
// always saved regardless of push outcome.

const DEFAULT_DURATION_MINS = 60;

// Shape we read off an Activity for sync. `metadata` carries the sync contract:
//   durationMins  number   meeting length (default 60), editable
//   addToGoogle   boolean  opt-out flag (default true when connected)
//   meetRequested boolean  create a Google Meet conference link (default false)
//   googleEventId string   stamped by us after push — loop-guard + patch/delete target
//   googleCalendarId/googleHtmlLink/meetLink — stamped echo for the UI
export interface SyncableMeeting {
  id: string;
  companyId: string;
  userId: string;
  type: string;
  title: string;
  content?: string | null;
  customerId?: string | null;
  dueDate?: Date | null;
  metadata?: Record<string, unknown> | null;
}

function meta(activity: SyncableMeeting): Record<string, unknown> {
  const m = activity.metadata;
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
}

/** Resolve the owner's active Google calendar connection, or null. */
async function ownerConnection(companyId: string, userId: string) {
  return prisma.calendarConnection.findFirst({
    where: { companyId, userId, provider: "google", status: { in: ["active", "error"] } },
  });
}

/** googleapis calendar client authorized for a connection's refresh token. */
function authedCalendar(refreshToken: string) {
  const clientId = getClientId();
  const clientSecret = getClientSecret();
  const client = new google.auth.OAuth2(clientId, clientSecret, env.CALENDAR_GOOGLE_REDIRECT_URI);
  client.setCredentials({ refresh_token: refreshToken });
  return google.calendar({ version: "v3", auth: client });
}

/** Persist the Google identifiers back onto the activity's metadata (merge). */
async function stampMeta(activity: SyncableMeeting, patch: Record<string, unknown>): Promise<void> {
  const next = { ...meta(activity), ...patch };
  await prisma.activity.update({ where: { id: activity.id }, data: { metadata: next as Prisma.InputJsonValue } });
}

/**
 * Push a meeting create/update to Google. Inserts a new event, or patches the
 * existing one when we've already stamped a googleEventId. No-throw.
 */
export async function pushMeetingForActivity(activity: SyncableMeeting): Promise<void> {
  try {
    if (activity.type !== "meeting") return;
    const m = meta(activity);
    if (m.addToGoogle === false) return;
    if (!activity.dueDate) return; // a calendar event needs a start time
    if (!(await isFeatureEnabled(activity.companyId, "calendar_sync"))) return;

    const conn = await ownerConnection(activity.companyId, activity.userId);
    if (!conn) return;
    const creds = JSON.parse(unseal(conn.sealedCreds)) as { refreshToken: string };
    const cal = authedCalendar(creds.refreshToken);

    const start = activity.dueDate;
    const durationMins = typeof m.durationMins === "number" && m.durationMins > 0 ? m.durationMins : DEFAULT_DURATION_MINS;
    const end = new Date(start.getTime() + durationMins * 60000);

    let attendees: { email: string }[] | undefined;
    if (activity.customerId) {
      const customer = await prisma.customer.findFirst({ where: { id: activity.customerId, companyId: activity.companyId }, select: { email: true } });
      const email = normEmail(customer?.email);
      if (email) attendees = [{ email }];
    }

    const wantMeet = m.meetRequested === true;
    const requestBody: Record<string, unknown> = {
      summary: activity.title,
      description: activity.content ?? undefined,
      start: { dateTime: start.toISOString(), timeZone: "UTC" },
      end: { dateTime: end.toISOString(), timeZone: "UTC" },
      attendees,
      // Loop-guard marker: the Phase B poller skips any event tagged zyrixSource=crm.
      extendedProperties: { private: { zyrixSource: "crm", zyrixActivityId: activity.id } },
    };
    if (wantMeet) {
      requestBody.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } };
    }

    const existingId = typeof m.googleEventId === "string" ? m.googleEventId : null;
    const res = existingId
      ? await cal.events.patch({ calendarId: conn.calendarId, eventId: existingId, conferenceDataVersion: wantMeet ? 1 : 0, requestBody })
      : await cal.events.insert({ calendarId: conn.calendarId, conferenceDataVersion: wantMeet ? 1 : 0, requestBody });

    const ev = res.data;
    const meetLink = ev.hangoutLink || ev.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri || null;
    await stampMeta(activity, {
      googleEventId: ev.id, googleCalendarId: conn.calendarId, googleHtmlLink: ev.htmlLink ?? null, meetLink,
    });
    await prisma.calendarConnection.update({ where: { id: conn.id }, data: { lastSyncAt: new Date(), status: "active", lastError: null } }).catch(() => {});
  } catch (e) {
    console.error("[calendar-sync] outbound push failed (non-fatal):", (e as Error).message);
  }
}

/** Cancel/delete the Google event for a meeting being removed. No-throw. */
export async function cancelMeetingForActivity(activity: SyncableMeeting): Promise<void> {
  try {
    if (activity.type !== "meeting") return;
    const eventId = meta(activity).googleEventId;
    if (typeof eventId !== "string" || !eventId) return;
    const conn = await ownerConnection(activity.companyId, activity.userId);
    if (!conn) return;
    const creds = JSON.parse(unseal(conn.sealedCreds)) as { refreshToken: string };
    const cal = authedCalendar(creds.refreshToken);
    await cal.events.delete({ calendarId: conn.calendarId, eventId });
  } catch (e) {
    console.error("[calendar-sync] outbound cancel failed (non-fatal):", (e as Error).message);
  }
}
