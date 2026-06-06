// ============================================================================
// SERVICE DESK — TICKETS SERVICE (raw SQL)
// ----------------------------------------------------------------------------
// Tenant-scoped (companyId). Tickets are auto-created from inbound channels
// (WhatsApp/Messenger/IG conversations, inbound email replies, portal) and
// can be created manually. Per-company `number` is an atomic sequence backed
// by ticket_counters. Internal notes reuse `comments` (entityType='ticket');
// ticket_events is the status/assign/reply audit log only.
//
// INERT-by-default: auto-create requires BOTH the `service_desk` entitlement
// AND an explicit per-company enable (service_desk_settings.enabled = true).
// ============================================================================

import { randomUUID } from "crypto";
import { prisma } from "../config/database";
import { isEnabled } from "./entitlements.service";
import {
  dispatchTicketCreated,
  dispatchTicketResolved,
} from "./workflow-events.service";
import { applySlaOnCreate, recomputeTicket, seedPresets } from "./sla.service";

const REOPEN_WINDOW_MS = 72 * 60 * 60 * 1000;

export const OPEN_STATUSES = ["new", "open", "pending"] as const;
export const CLOSED_STATUSES = ["resolved", "closed"] as const;
const ALL_STATUSES: string[] = [...OPEN_STATUSES, ...CLOSED_STATUSES];
const ALL_PRIORITIES = ["low", "normal", "high", "urgent"];
export const TICKET_CHANNELS = [
  "whatsapp",
  "messenger",
  "instagram",
  "email",
  "portal",
  "manual",
] as const;

export interface TicketRow {
  id: string;
  companyId: string;
  number: number;
  customerId: string | null;
  channel: string;
  subject: string | null;
  status: string;
  priority: string;
  assigneeId: string | null;
  conversationId: string | null;
  emailMessageId: string | null;
  firstResponseAt: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  lastCustomerMsgAt: Date | null;
  slaPolicyId: string | null;
  firstResponseDueAt: Date | null;
  resolveDueAt: Date | null;
  slaBreachedAt: Date | null;
  slaState: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const COLS = `
  "id","companyId","number","customerId","channel","subject","status","priority",
  "assigneeId","conversationId","emailMessageId","firstResponseAt","resolvedAt",
  "closedAt","lastCustomerMsgAt","slaPolicyId","firstResponseDueAt","resolveDueAt",
  "slaBreachedAt","slaState","createdAt","updatedAt"
`;

// ──────────────────────────────────────────────────────────────────────
// Settings (one-click enable) + activation check
// ──────────────────────────────────────────────────────────────────────

export interface ServiceDeskSettings {
  companyId: string;
  enabled: boolean;
  autoCreate: boolean;
  defaultSlaPolicyId: string | null;
}

export async function getSettings(companyId: string): Promise<ServiceDeskSettings> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT "companyId","enabled","autoCreate","defaultSlaPolicyId"
       FROM service_desk_settings WHERE "companyId" = $1 LIMIT 1`,
    companyId
  )) as ServiceDeskSettings[];
  return rows[0] ?? { companyId, enabled: false, autoCreate: true, defaultSlaPolicyId: null };
}

export async function updateSettings(
  companyId: string,
  patch: { enabled?: boolean; autoCreate?: boolean; defaultSlaPolicyId?: string | null }
): Promise<ServiceDeskSettings> {
  const current = await getSettings(companyId);
  const enabled = patch.enabled ?? current.enabled;
  const autoCreate = patch.autoCreate ?? current.autoCreate;
  let defaultSlaPolicyId =
    patch.defaultSlaPolicyId !== undefined ? patch.defaultSlaPolicyId : current.defaultSlaPolicyId;

  // One-click setup: turning the desk on seeds the 3 SLA presets + picks the
  // recommended default if the merchant hasn't chosen one yet.
  if (enabled && !defaultSlaPolicyId) {
    defaultSlaPolicyId = await seedPresets(companyId);
  }

  await prisma.$executeRawUnsafe(
    `INSERT INTO service_desk_settings ("companyId","enabled","autoCreate","defaultSlaPolicyId","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,NOW(),NOW())
     ON CONFLICT ("companyId")
     DO UPDATE SET "enabled" = EXCLUDED."enabled",
                   "autoCreate" = EXCLUDED."autoCreate",
                   "defaultSlaPolicyId" = EXCLUDED."defaultSlaPolicyId",
                   "updatedAt" = NOW()`,
    companyId,
    enabled,
    autoCreate,
    defaultSlaPolicyId
  );
  return { companyId, enabled, autoCreate, defaultSlaPolicyId };
}

/** Entitled AND merchant-enabled. Both required ⇒ fully inert until opt-in. */
export async function isServiceDeskActive(companyId: string): Promise<boolean> {
  const settings = await getSettings(companyId);
  if (!settings.enabled) return false;
  return isEnabled(companyId, "service_desk");
}

// ──────────────────────────────────────────────────────────────────────
// Numbering + event log
// ──────────────────────────────────────────────────────────────────────

async function nextTicketNumber(companyId: string): Promise<number> {
  const rows = (await prisma.$queryRawUnsafe(
    `INSERT INTO ticket_counters ("companyId","lastNumber") VALUES ($1, 1)
     ON CONFLICT ("companyId")
     DO UPDATE SET "lastNumber" = ticket_counters."lastNumber" + 1
     RETURNING "lastNumber"`,
    companyId
  )) as Array<{ lastNumber: number }>;
  return Number(rows[0].lastNumber);
}

export async function logEvent(
  companyId: string,
  ticketId: string,
  type: string,
  opts: {
    actorUserId?: string | null;
    fromValue?: string | null;
    toValue?: string | null;
    metadata?: Record<string, unknown>;
  } = {}
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO ticket_events ("id","ticketId","companyId","type","actorUserId","fromValue","toValue","metadata","createdAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,NOW())`,
    randomUUID(),
    ticketId,
    companyId,
    type,
    opts.actorUserId ?? null,
    opts.fromValue ?? null,
    opts.toValue ?? null,
    JSON.stringify(opts.metadata ?? {})
  );
}

function toPayload(t: TicketRow) {
  return {
    id: t.id,
    number: t.number,
    subject: t.subject,
    channel: t.channel,
    status: t.status,
    priority: t.priority,
    customerId: t.customerId,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Create
// ──────────────────────────────────────────────────────────────────────

export interface CreateTicketParams {
  companyId: string;
  customerId?: string | null;
  channel: string;
  subject?: string | null;
  priority?: string;
  assigneeId?: string | null;
  conversationId?: string | null;
  emailMessageId?: string | null;
  lastCustomerMsgAt?: Date | null;
  actorUserId?: string | null; // null = system/customer
}

export async function createTicket(params: CreateTicketParams): Promise<TicketRow> {
  const channel = TICKET_CHANNELS.includes(params.channel as any)
    ? params.channel
    : "manual";
  const priority = ALL_PRIORITIES.includes(params.priority ?? "")
    ? (params.priority as string)
    : "normal";
  const subject = params.subject ? params.subject.slice(0, 200) : null;
  const id = randomUUID();
  const number = await nextTicketNumber(params.companyId);

  const rows = (await prisma.$queryRawUnsafe(
    `INSERT INTO tickets
       ("id","companyId","number","customerId","channel","subject","status","priority",
        "assigneeId","conversationId","emailMessageId","lastCustomerMsgAt","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,'new',$7,$8,$9,$10,$11,NOW(),NOW())
     RETURNING ${COLS}`,
    id,
    params.companyId,
    number,
    params.customerId ?? null,
    channel,
    subject,
    priority,
    params.assigneeId ?? null,
    params.conversationId ?? null,
    params.emailMessageId ?? null,
    params.lastCustomerMsgAt ?? null
  )) as TicketRow[];
  const ticket = rows[0];

  await logEvent(params.companyId, ticket.id, "created", {
    actorUserId: params.actorUserId ?? null,
    metadata: { channel, number },
  });
  void dispatchTicketCreated(params.companyId, toPayload(ticket));
  // SLA: stamp first-response/resolution due times from the company's policy.
  await applySlaOnCreate(params.companyId, ticket.id, ticket.createdAt);
  return ticket;
}

// ──────────────────────────────────────────────────────────────────────
// Auto-create from inbound (the one-click principle)
// ──────────────────────────────────────────────────────────────────────

export interface InboundContext {
  companyId: string;
  channel: string;
  customerId?: string | null;
  conversationId?: string | null;
  emailMessageId?: string | null;
  subject?: string | null;
  occurredAt?: Date | null;
}

/**
 * Ensure a ticket exists for an inbound message. Reuses an open ticket for the
 * same thread/customer+channel; reopens a recently-closed one within 72h;
 * otherwise creates a new one. Never throws — inbound ingestion must not break.
 * Returns the ticket id, or null when the desk is inactive / a no-op.
 */
export async function ensureTicketForInbound(
  ctx: InboundContext
): Promise<string | null> {
  try {
    const settings = await getSettings(ctx.companyId);
    if (!settings.enabled || !settings.autoCreate) return null;
    if (!(await isEnabled(ctx.companyId, "service_desk"))) return null;

    const channel = ctx.channel;
    const at = ctx.occurredAt ?? new Date();

    // 1) Existing open ticket for this thread (conversation) or customer+channel.
    const open = await findReusableTicket(ctx, OPEN_STATUSES as unknown as string[]);
    if (open) {
      await prisma.$executeRawUnsafe(
        `UPDATE tickets SET "lastCustomerMsgAt" = $1, "updatedAt" = NOW() WHERE "id" = $2`,
        at,
        open.id
      );
      await logEvent(ctx.companyId, open.id, "reply_in", { metadata: { channel } });
      return open.id;
    }

    // 2) Recently-closed ticket within 72h → reopen instead of duplicating.
    const reopenable = await findReusableTicket(
      ctx,
      CLOSED_STATUSES as unknown as string[],
      REOPEN_WINDOW_MS
    );
    if (reopenable) {
      await prisma.$executeRawUnsafe(
        `UPDATE tickets
            SET "status" = 'open', "resolvedAt" = NULL, "closedAt" = NULL,
                "lastCustomerMsgAt" = $1, "updatedAt" = NOW()
          WHERE "id" = $2`,
        at,
        reopenable.id
      );
      await logEvent(ctx.companyId, reopenable.id, "reopened", {
        fromValue: reopenable.status,
        toValue: "open",
        metadata: { channel, reason: "inbound_within_72h" },
      });
      await logEvent(ctx.companyId, reopenable.id, "reply_in", { metadata: { channel } });
      return reopenable.id;
    }

    // 3) New ticket.
    const created = await createTicket({
      companyId: ctx.companyId,
      customerId: ctx.customerId ?? null,
      channel,
      subject: ctx.subject ?? null,
      conversationId: ctx.conversationId ?? null,
      emailMessageId: ctx.emailMessageId ?? null,
      lastCustomerMsgAt: at,
      actorUserId: null,
    });
    return created.id;
  } catch (e) {
    console.error("[tickets] ensureTicketForInbound failed:", (e as Error).message);
    return null;
  }
}

/** Find a reuse candidate: prefer conversation match, else customer+channel. */
async function findReusableTicket(
  ctx: InboundContext,
  statuses: string[],
  withinMs?: number
): Promise<TicketRow | null> {
  const statusList = statuses.filter((s) => ALL_STATUSES.includes(s));
  if (statusList.length === 0) return null;

  // Recency guard for reopen: only consider tickets closed within the window.
  const recencyClause = withinMs
    ? `AND COALESCE("closedAt","resolvedAt","updatedAt") >= NOW() - ($/ms/ || ' milliseconds')::interval`
    : "";

  if (ctx.conversationId) {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT ${COLS} FROM tickets
        WHERE "companyId" = $1 AND "conversationId" = $2
          AND "status" = ANY($3::text[]) ${recencyClause.replace("$/ms/", "$4")}
        ORDER BY "createdAt" DESC LIMIT 1`,
      ...(withinMs
        ? [ctx.companyId, ctx.conversationId, statusList, String(withinMs)]
        : [ctx.companyId, ctx.conversationId, statusList])
    )) as TicketRow[];
    if (rows[0]) return rows[0];
  }

  if (ctx.customerId) {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT ${COLS} FROM tickets
        WHERE "companyId" = $1 AND "customerId" = $2 AND "channel" = $3
          AND "status" = ANY($4::text[]) ${recencyClause.replace("$/ms/", "$5")}
        ORDER BY "createdAt" DESC LIMIT 1`,
      ...(withinMs
        ? [ctx.companyId, ctx.customerId, ctx.channel, statusList, String(withinMs)]
        : [ctx.companyId, ctx.customerId, ctx.channel, statusList])
    )) as TicketRow[];
    if (rows[0]) return rows[0];
  }

  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Read — queue + detail
// ──────────────────────────────────────────────────────────────────────

export interface TicketListFilters {
  status?: string; // single status, or 'open' meta = all OPEN_STATUSES
  assigneeId?: string;
  mine?: string; // userId — assigned to me
  unassigned?: boolean;
  channel?: string;
  breachingSoon?: boolean; // wired in Phase B (SLA) — no-op until then
  limit?: number;
}

export async function listTickets(
  companyId: string,
  filters: TicketListFilters = {}
): Promise<Array<TicketRow & { customerName: string | null; assigneeName: string | null }>> {
  const where: string[] = [`t."companyId" = $1`];
  const args: unknown[] = [companyId];
  let i = 2;

  if (filters.status === "open") {
    where.push(`t."status" = ANY($${i}::text[])`);
    args.push([...OPEN_STATUSES]);
    i++;
  } else if (filters.status && ALL_STATUSES.includes(filters.status)) {
    where.push(`t."status" = $${i}`);
    args.push(filters.status);
    i++;
  }
  if (filters.mine) {
    where.push(`t."assigneeId" = $${i}`);
    args.push(filters.mine);
    i++;
  } else if (filters.assigneeId) {
    where.push(`t."assigneeId" = $${i}`);
    args.push(filters.assigneeId);
    i++;
  } else if (filters.unassigned) {
    where.push(`t."assigneeId" IS NULL`);
  }
  if (filters.channel && TICKET_CHANNELS.includes(filters.channel as any)) {
    where.push(`t."channel" = $${i}`);
    args.push(filters.channel);
    i++;
  }
  if (filters.breachingSoon) {
    where.push(`t."slaState" IN ('near_breach','breached')`);
  }

  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  args.push(limit);

  return (await prisma.$queryRawUnsafe(
    `SELECT t."id", t."companyId", t."number", t."customerId", t."channel", t."subject",
            t."status", t."priority", t."assigneeId", t."conversationId", t."emailMessageId",
            t."firstResponseAt", t."resolvedAt", t."closedAt", t."lastCustomerMsgAt",
            t."slaPolicyId", t."firstResponseDueAt", t."resolveDueAt", t."slaBreachedAt", t."slaState",
            t."createdAt", t."updatedAt",
            cu."fullName" AS "customerName",
            u."fullName" AS "assigneeName"
       FROM tickets t
       LEFT JOIN customers cu ON cu."id" = t."customerId"
       LEFT JOIN users u ON u."id" = t."assigneeId"
      WHERE ${where.join(" AND ")}
      ORDER BY
        CASE t."status" WHEN 'new' THEN 0 WHEN 'open' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
        t."lastCustomerMsgAt" DESC NULLS LAST,
        t."createdAt" DESC
      LIMIT $${i}`,
    ...args
  )) as any;
}

export async function getTicket(
  companyId: string,
  id: string
): Promise<(TicketRow & { customerName: string | null; assigneeName: string | null }) | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT t."id", t."companyId", t."number", t."customerId", t."channel", t."subject",
            t."status", t."priority", t."assigneeId", t."conversationId", t."emailMessageId",
            t."firstResponseAt", t."resolvedAt", t."closedAt", t."lastCustomerMsgAt",
            t."slaPolicyId", t."firstResponseDueAt", t."resolveDueAt", t."slaBreachedAt", t."slaState",
            t."createdAt", t."updatedAt",
            cu."fullName" AS "customerName",
            u."fullName" AS "assigneeName"
       FROM tickets t
       LEFT JOIN customers cu ON cu."id" = t."customerId"
       LEFT JOIN users u ON u."id" = t."assigneeId"
      WHERE t."companyId" = $1 AND t."id" = $2 LIMIT 1`,
    companyId,
    id
  )) as any[];
  return rows[0] ?? null;
}

export async function listTicketEvents(companyId: string, ticketId: string) {
  return (await prisma.$queryRawUnsafe(
    `SELECT e."id", e."type", e."actorUserId", e."fromValue", e."toValue", e."metadata", e."createdAt",
            u."fullName" AS "actorName"
       FROM ticket_events e
       LEFT JOIN users u ON u."id" = e."actorUserId"
      WHERE e."companyId" = $1 AND e."ticketId" = $2
      ORDER BY e."createdAt" ASC`,
    companyId,
    ticketId
  )) as any[];
}

export async function getCounts(
  companyId: string,
  userId: string
): Promise<{ open: number; unassigned: number; mine: number; breachingSoon: number }> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT
       COUNT(*) FILTER (WHERE "status" = ANY($2::text[])) AS "open",
       COUNT(*) FILTER (WHERE "status" = ANY($2::text[]) AND "assigneeId" IS NULL) AS "unassigned",
       COUNT(*) FILTER (WHERE "status" = ANY($2::text[]) AND "assigneeId" = $3) AS "mine",
       COUNT(*) FILTER (WHERE "status" = ANY($2::text[]) AND "slaState" IN ('near_breach','breached')) AS "breachingSoon"
     FROM tickets WHERE "companyId" = $1`,
    companyId,
    [...OPEN_STATUSES],
    userId
  )) as Array<{ open: bigint; unassigned: bigint; mine: bigint; breachingSoon: bigint }>;
  const r = rows[0];
  return {
    open: Number(r.open),
    unassigned: Number(r.unassigned),
    mine: Number(r.mine),
    breachingSoon: Number(r.breachingSoon),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Mutate — status / priority / assignment
// ──────────────────────────────────────────────────────────────────────

export interface UpdateTicketDto {
  status?: string;
  priority?: string;
  assigneeId?: string | null;
}

export async function updateTicket(
  companyId: string,
  id: string,
  actorUserId: string,
  dto: UpdateTicketDto
): Promise<TicketRow | null> {
  const current = await getRaw(companyId, id);
  if (!current) return null;

  const sets: string[] = [];
  const args: unknown[] = [];
  let i = 1;
  let becameResolved = false;

  if (dto.status && ALL_STATUSES.includes(dto.status) && dto.status !== current.status) {
    sets.push(`"status" = $${i}`);
    args.push(dto.status);
    i++;
    if (dto.status === "resolved") {
      sets.push(`"resolvedAt" = NOW()`);
      becameResolved = true;
    } else if (dto.status === "closed") {
      sets.push(`"closedAt" = NOW()`);
    } else if (OPEN_STATUSES.includes(dto.status as any)) {
      // Reopen — clear closure stamps.
      sets.push(`"resolvedAt" = NULL`, `"closedAt" = NULL`);
    }
  }
  if (dto.priority && ALL_PRIORITIES.includes(dto.priority) && dto.priority !== current.priority) {
    sets.push(`"priority" = $${i}`);
    args.push(dto.priority);
    i++;
  }
  const assigneeChanged =
    dto.assigneeId !== undefined && (dto.assigneeId ?? null) !== current.assigneeId;
  if (assigneeChanged) {
    sets.push(`"assigneeId" = $${i}`);
    args.push(dto.assigneeId ?? null);
    i++;
  }

  if (sets.length === 0) return current;

  sets.push(`"updatedAt" = NOW()`);
  args.push(companyId, id);
  const rows = (await prisma.$queryRawUnsafe(
    `UPDATE tickets SET ${sets.join(", ")} WHERE "companyId" = $${i} AND "id" = $${i + 1} RETURNING ${COLS}`,
    ...args
  )) as TicketRow[];
  const updated = rows[0];

  // Event log
  if (dto.status && dto.status !== current.status) {
    const type =
      dto.status === "resolved" ? "resolved" : dto.status === "closed" ? "closed" : "status_changed";
    await logEvent(companyId, id, type, {
      actorUserId,
      fromValue: current.status,
      toValue: dto.status,
    });
  }
  if (assigneeChanged) {
    await logEvent(companyId, id, "assigned", {
      actorUserId,
      fromValue: current.assigneeId,
      toValue: dto.assigneeId ?? null,
    });
  }

  if (becameResolved) void dispatchTicketResolved(companyId, toPayload(updated));
  return updated;
}

/**
 * Record an outbound (agent) reply on a ticket: stamps firstResponseAt on the
 * first reply, bumps a 'new' ticket to 'open', logs reply_out.
 */
export async function recordOutboundReply(
  companyId: string,
  ticketId: string,
  actorUserId: string
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE tickets
        SET "firstResponseAt" = COALESCE("firstResponseAt", NOW()),
            "status" = CASE WHEN "status" = 'new' THEN 'open' ELSE "status" END,
            "updatedAt" = NOW()
      WHERE "companyId" = $1 AND "id" = $2`,
    companyId,
    ticketId
  );
  await logEvent(companyId, ticketId, "reply_out", { actorUserId });
  // First response may satisfy the first-response SLA → refresh the badge.
  void recomputeTicket(companyId, ticketId);
}

async function getRaw(companyId: string, id: string): Promise<TicketRow | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT ${COLS} FROM tickets WHERE "companyId" = $1 AND "id" = $2 LIMIT 1`,
    companyId,
    id
  )) as TicketRow[];
  return rows[0] ?? null;
}
