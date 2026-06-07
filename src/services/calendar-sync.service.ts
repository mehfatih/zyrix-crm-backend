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

import { google } from "googleapis";
import jwt from "jsonwebtoken";
import { prisma } from "../config/database";
import { env } from "../config/env";
import { getClientId, getClientSecret } from "./google/config";
import { encryptToken, decryptToken, type SealedToken } from "../lib/crypto/tokenCipher";
import { badRequest } from "../middleware/errorHandler";
import { integrationError } from "../lib/errors/integrationErrors";

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
