// ============================================================================
// SERVICE DESK — SLA ENGINE (Sprint 18B, raw SQL)
// ----------------------------------------------------------------------------
// 24/7 v1: first-response + resolution timers run continuously. 3 presets are
// seeded per company on enable; the chosen one lives on
// service_desk_settings.defaultSlaPolicyId. A 5-min cron computes slaState
// (ok|near_breach|breached), stamps slaBreachedAt once, fires an escalation
// notification + the ticket.sla_breached trigger. No cycle with ticket.service
// (events inserted via a local helper).
// ============================================================================

import { randomUUID } from "crypto";
import { prisma } from "../config/database";
import { isEnabled } from "./entitlements.service";
import { dispatchTicketSlaBreached } from "./workflow-events.service";
import { createNotification, createBulkNotifications } from "./notifications.service";

const NEAR_FRACTION = 0.2; // near-breach once ≤20% of the active window remains
const OPEN_STATUSES = ["new", "open", "pending"];

export interface SlaPolicyRow {
  id: string;
  companyId: string;
  name: string;
  firstResponseMins: number;
  resolveMins: number;
  businessHours: unknown;
  escalateToUserId: string | null;
}

// name = stable key (localized in the UI). v1 24/7 (businessHours null).
export const SLA_PRESETS: Array<{ name: string; firstResponseMins: number; resolveMins: number }> = [
  { name: "relaxed", firstResponseMins: 1440, resolveMins: 4320 }, // 24h / 72h
  { name: "standard", firstResponseMins: 60, resolveMins: 1440 }, // 1h / 24h
  { name: "strict", firstResponseMins: 15, resolveMins: 240 }, // 15m / 4h
];
const DEFAULT_PRESET = "standard";

const POLICY_COLS = `"id","companyId","name","firstResponseMins","resolveMins","businessHours","escalateToUserId"`;

export async function listPolicies(companyId: string): Promise<SlaPolicyRow[]> {
  return (await prisma.$queryRawUnsafe(
    `SELECT ${POLICY_COLS} FROM sla_policies WHERE "companyId" = $1 ORDER BY "resolveMins" DESC`,
    companyId
  )) as SlaPolicyRow[];
}

export async function getPolicy(companyId: string, id: string): Promise<SlaPolicyRow | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT ${POLICY_COLS} FROM sla_policies WHERE "companyId" = $1 AND "id" = $2 LIMIT 1`,
    companyId,
    id
  )) as SlaPolicyRow[];
  return rows[0] ?? null;
}

/**
 * Seed the 3 presets for a company if none exist. Idempotent. Returns the id
 * of the recommended default ("standard"), or the existing default if already
 * seeded.
 */
export async function seedPresets(companyId: string): Promise<string | null> {
  const existing = await listPolicies(companyId);
  if (existing.length > 0) {
    const std = existing.find((p) => p.name === DEFAULT_PRESET);
    return (std ?? existing[0])?.id ?? null;
  }
  let defaultId: string | null = null;
  for (const p of SLA_PRESETS) {
    const id = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO sla_policies ("id","companyId","name","firstResponseMins","resolveMins","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,NOW(),NOW())`,
      id,
      companyId,
      p.name,
      p.firstResponseMins,
      p.resolveMins
    );
    if (p.name === DEFAULT_PRESET) defaultId = id;
  }
  return defaultId;
}

/** Compute + stamp the SLA due times on a freshly-created ticket. */
export async function applySlaOnCreate(
  companyId: string,
  ticketId: string,
  createdAt: Date
): Promise<void> {
  const settings = (await prisma.$queryRawUnsafe(
    `SELECT "defaultSlaPolicyId" FROM service_desk_settings WHERE "companyId" = $1 LIMIT 1`,
    companyId
  )) as Array<{ defaultSlaPolicyId: string | null }>;
  const policyId = settings[0]?.defaultSlaPolicyId ?? null;
  if (!policyId) return;
  const policy = await getPolicy(companyId, policyId);
  if (!policy) return;

  const frDue = new Date(createdAt.getTime() + policy.firstResponseMins * 60_000);
  const resDue = new Date(createdAt.getTime() + policy.resolveMins * 60_000);
  await prisma.$executeRawUnsafe(
    `UPDATE tickets
        SET "slaPolicyId" = $1, "firstResponseDueAt" = $2, "resolveDueAt" = $3,
            "slaState" = 'ok', "updatedAt" = NOW()
      WHERE "companyId" = $4 AND "id" = $5`,
    policyId,
    frDue,
    resDue,
    companyId,
    ticketId
  );
}

interface SlaTicket {
  id: string;
  companyId: string;
  number: number;
  subject: string | null;
  channel: string;
  status: string;
  priority: string;
  customerId: string | null;
  assigneeId: string | null;
  firstResponseAt: Date | null;
  firstResponseDueAt: Date | null;
  resolveDueAt: Date | null;
  slaBreachedAt: Date | null;
  slaState: string | null;
  slaPolicyId: string | null;
  createdAt: Date;
}

interface StateResult {
  state: "ok" | "near_breach" | "breached";
  breachKind: "first_response" | "resolution";
  activeDue: Date | null;
}

/** Pure computation of the current SLA state for a ticket at `now`. */
export function computeState(t: SlaTicket, now: Date): StateResult {
  // First-response phase until the agent replies; then resolution phase.
  const inFirstResponse = !t.firstResponseAt;
  const breachKind: StateResult["breachKind"] = inFirstResponse ? "first_response" : "resolution";
  const activeDue = inFirstResponse ? t.firstResponseDueAt : t.resolveDueAt;
  if (!activeDue) return { state: "ok", breachKind, activeDue: null };

  const dueMs = activeDue.getTime();
  const nowMs = now.getTime();
  if (nowMs > dueMs) return { state: "breached", breachKind, activeDue };

  const windowMs = dueMs - t.createdAt.getTime();
  const nearStart = dueMs - windowMs * NEAR_FRACTION;
  if (nowMs >= nearStart) return { state: "near_breach", breachKind, activeDue };
  return { state: "ok", breachKind, activeDue };
}

/** Recompute one ticket's slaState (badge only — no breach firing). */
export async function recomputeTicket(companyId: string, ticketId: string): Promise<void> {
  const rows = (await loadTickets(`t."companyId" = $1 AND t."id" = $2`, [companyId, ticketId])) as SlaTicket[];
  const t = rows[0];
  if (!t || !t.slaPolicyId) return;
  if (!OPEN_STATUSES.includes(t.status)) return;
  const { state } = computeState(t, new Date());
  if (state !== t.slaState) {
    await prisma.$executeRawUnsafe(
      `UPDATE tickets SET "slaState" = $1, "updatedAt" = NOW() WHERE "id" = $2`,
      state,
      ticketId
    );
  }
}

async function loadTickets(whereClause: string, args: unknown[]): Promise<SlaTicket[]> {
  return (await prisma.$queryRawUnsafe(
    `SELECT t."id", t."companyId", t."number", t."subject", t."channel", t."status", t."priority",
            t."customerId", t."assigneeId", t."firstResponseAt", t."firstResponseDueAt",
            t."resolveDueAt", t."slaBreachedAt", t."slaState", t."slaPolicyId", t."createdAt"
       FROM tickets t
      WHERE ${whereClause}`,
    ...args
  )) as SlaTicket[];
}

async function logSlaEvent(
  companyId: string,
  ticketId: string,
  type: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO ticket_events ("id","ticketId","companyId","type","metadata","createdAt")
     VALUES ($1,$2,$3,$4,$5::jsonb,NOW())`,
    randomUUID(),
    ticketId,
    companyId,
    type,
    JSON.stringify(metadata)
  );
}

async function escalate(t: SlaTicket, breachKind: string): Promise<void> {
  const policy = t.slaPolicyId ? await getPolicy(t.companyId, t.slaPolicyId) : null;
  const title = `SLA breach — ticket #${t.number}`;
  const body = t.subject ?? "";
  const link = `/tickets/${t.id}`;
  const payload = { kind: "ticket_sla_breach", title, body, link, entityType: "ticket", entityId: t.id };

  const target = policy?.escalateToUserId || t.assigneeId;
  if (target) {
    await createNotification({ companyId: t.companyId, userId: target, ...payload });
    return;
  }
  // Unassigned + no escalation target → ping the managers/owner.
  const managers = (await prisma.$queryRawUnsafe(
    `SELECT id FROM users WHERE "companyId" = $1 AND status = 'active' AND role IN ('owner','admin','manager')`,
    t.companyId
  )) as Array<{ id: string }>;
  if (managers.length > 0) {
    await createBulkNotifications(
      t.companyId,
      managers.map((m) => m.id),
      payload
    );
  }
}

/**
 * 5-min cron sweep. Recompute slaState for every open ticket with an SLA;
 * on a NEW breach, stamp slaBreachedAt once, log the event, fire the trigger
 * + escalation. Per-company gated by the `service_sla` entitlement.
 */
export async function sweepBreaches(): Promise<{ scanned: number; breached: number }> {
  const now = new Date();
  const tickets = await loadTickets(
    `t."slaPolicyId" IS NOT NULL AND t."status" = ANY($1::text[])`,
    [OPEN_STATUSES]
  );

  const entitledCache = new Map<string, boolean>();
  let breached = 0;

  for (const t of tickets) {
    // Per-company gate (cached).
    let entitled = entitledCache.get(t.companyId);
    if (entitled === undefined) {
      entitled = await isEnabled(t.companyId, "service_sla");
      entitledCache.set(t.companyId, entitled);
    }
    if (!entitled) continue;

    const { state, breachKind } = computeState(t, now);

    if (state !== t.slaState) {
      await prisma.$executeRawUnsafe(
        `UPDATE tickets SET "slaState" = $1, "updatedAt" = NOW() WHERE "id" = $2`,
        state,
        t.id
      );
      if (state === "near_breach" && t.slaState !== "near_breach") {
        await logSlaEvent(t.companyId, t.id, "sla_near", { breachKind });
      }
    }

    // Fire breach side-effects once (slaBreachedAt was null).
    if (state === "breached" && !t.slaBreachedAt) {
      await prisma.$executeRawUnsafe(
        `UPDATE tickets SET "slaBreachedAt" = NOW(), "updatedAt" = NOW() WHERE "id" = $1`,
        t.id
      );
      await logSlaEvent(t.companyId, t.id, "sla_breached", { breachKind });
      void dispatchTicketSlaBreached(
        t.companyId,
        {
          id: t.id,
          number: t.number,
          subject: t.subject,
          channel: t.channel,
          status: t.status,
          priority: t.priority,
          customerId: t.customerId,
        },
        breachKind
      );
      await escalate(t, breachKind);
      breached++;
    }
  }

  return { scanned: tickets.length, breached };
}
