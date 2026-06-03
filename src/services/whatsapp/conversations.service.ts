// ============================================================================
// CONVERSATIONS / MESSAGES SERVICE (raw SQL)
// ----------------------------------------------------------------------------
// Tenant-scoped (companyId) data access for the unified inbox. Channel-generic.
// Matches the connections.service raw-SQL pattern (no generated-client dep).
// ============================================================================

import { randomUUID } from "crypto";
import { prisma } from "../../config/database";

const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ConversationRow {
  id: string;
  companyId: string;
  channel: string;
  externalThreadId: string;
  contactId: string | null;
  dealId: string | null;
  assignedUserId: string | null;
  status: string;
  lastMessageAt: Date | null;
  windowExpiresAt: Date | null;
  lastInboundAt: Date | null;
  unreadCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageRow {
  id: string;
  conversationId: string;
  companyId: string;
  direction: string;
  externalMessageId: string | null;
  type: string;
  body: string | null;
  mediaUrl: string | null;
  status: string;
  errorDetail: string | null;
  sentByUserId: string | null;
  sentAt: Date | null;
  createdAt: Date;
}

const digits = (s: string): string => (s || "").replace(/\D/g, "");

/**
 * Match a contact by phone (digits-only across phone + whatsappPhone), or
 * create one. Returns the customer id. Inbound-driven, so a new lead is a
 * 'new' customer sourced 'whatsapp'.
 */
export async function findOrCreateContactByPhone(
  companyId: string,
  phone: string,
  displayName?: string
): Promise<string> {
  const norm = digits(phone);
  const found = (await prisma.$queryRawUnsafe(
    `SELECT "id" FROM customers
      WHERE "companyId" = $1
        AND (regexp_replace(coalesce("phone",''), '\\D', '', 'g') = $2
          OR regexp_replace(coalesce("whatsappPhone",''), '\\D', '', 'g') = $2)
      LIMIT 1`,
    companyId,
    norm
  )) as Array<{ id: string }>;
  if (found[0]) return found[0].id;

  const id = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO customers ("id","companyId","fullName","phone","whatsappPhone","source","status","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$4,'whatsapp','new',NOW(),NOW())`,
    id,
    companyId,
    displayName && displayName.trim() ? displayName.trim() : `WhatsApp ${phone}`,
    phone
  );
  return id;
}

const CONV_COLS = `
  "id","companyId","channel","externalThreadId","contactId","dealId","assignedUserId",
  "status","lastMessageAt","windowExpiresAt","lastInboundAt","unreadCount","createdAt","updatedAt"
`;

export async function getConversation(
  companyId: string,
  id: string
): Promise<ConversationRow | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT ${CONV_COLS} FROM conversations WHERE "companyId" = $1 AND "id" = $2 LIMIT 1`,
    companyId,
    id
  )) as ConversationRow[];
  return rows[0] ?? null;
}

/**
 * Get-or-create the conversation for (company, channel, thread) and link the
 * contact. Returns the conversation id.
 */
export async function upsertConversation(params: {
  companyId: string;
  channel: string;
  externalThreadId: string;
  contactId: string;
}): Promise<string> {
  const { companyId, channel, externalThreadId, contactId } = params;
  const existing = (await prisma.$queryRawUnsafe(
    `SELECT "id" FROM conversations WHERE "companyId" = $1 AND "channel" = $2 AND "externalThreadId" = $3 LIMIT 1`,
    companyId,
    channel,
    externalThreadId
  )) as Array<{ id: string }>;
  if (existing[0]) {
    await prisma.$executeRawUnsafe(
      `UPDATE conversations SET "contactId" = COALESCE("contactId", $1), "updatedAt" = NOW() WHERE "id" = $2`,
      contactId,
      existing[0].id
    );
    return existing[0].id;
  }
  const id = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO conversations ("id","companyId","channel","externalThreadId","contactId","status","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,'open',NOW(),NOW())`,
    id,
    companyId,
    channel,
    externalThreadId,
    contactId
  );
  return id;
}

/** Insert a message (idempotent on externalMessageId). Returns the row id. */
export async function appendMessage(m: {
  conversationId: string;
  companyId: string;
  direction: "in" | "out";
  externalMessageId?: string | null;
  type?: string;
  body?: string | null;
  mediaUrl?: string | null;
  status?: string;
  sentByUserId?: string | null;
  sentAt?: Date | null;
}): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO messages
       ("id","conversationId","companyId","direction","externalMessageId","type","body","mediaUrl","status","sentByUserId","sentAt","createdAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
     ON CONFLICT ("externalMessageId") WHERE "externalMessageId" IS NOT NULL DO NOTHING`,
    randomUUID(),
    m.conversationId,
    m.companyId,
    m.direction,
    m.externalMessageId ?? null,
    m.type ?? "text",
    m.body ?? null,
    m.mediaUrl ?? null,
    m.status ?? (m.direction === "in" ? "received" : "sent"),
    m.sentByUserId ?? null,
    m.sentAt ?? null
  );
}

/** Roll up conversation state after an INBOUND message (opens the 24h window). */
export async function touchInbound(conversationId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE conversations
        SET "lastMessageAt" = NOW(), "lastInboundAt" = NOW(),
            "windowExpiresAt" = NOW() + ($1 || ' milliseconds')::interval,
            "status" = CASE WHEN "status" = 'closed' THEN 'open' ELSE "status" END,
            "unreadCount" = "unreadCount" + 1, "updatedAt" = NOW()
      WHERE "id" = $2`,
    String(WINDOW_MS),
    conversationId
  );
}

/** Roll up after an OUTBOUND message (does not extend the window). */
export async function touchOutbound(conversationId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE conversations SET "lastMessageAt" = NOW(), "updatedAt" = NOW() WHERE "id" = $1`,
    conversationId
  );
}

/** True if the free-form 24h service window is still open. */
export function isWithinWindow(conv: ConversationRow): boolean {
  return Boolean(conv.windowExpiresAt && conv.windowExpiresAt.getTime() > Date.now());
}

export async function listConversations(
  companyId: string,
  opts: { limit?: number; status?: string } = {}
): Promise<Array<ConversationRow & { contactName: string | null; contactPhone: string | null; lastBody: string | null }>> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const statusFilter = opts.status ? `AND c."status" = '${opts.status.replace(/[^a-z]/g, "")}'` : "";
  return (await prisma.$queryRawUnsafe(
    `SELECT c."id", c."companyId", c."channel", c."externalThreadId", c."contactId", c."dealId",
            c."assignedUserId", c."status", c."lastMessageAt", c."windowExpiresAt", c."lastInboundAt",
            c."unreadCount", c."createdAt", c."updatedAt",
            cu."fullName" AS "contactName", cu."phone" AS "contactPhone",
            (SELECT m."body" FROM messages m WHERE m."conversationId" = c."id" ORDER BY m."createdAt" DESC LIMIT 1) AS "lastBody"
       FROM conversations c
       LEFT JOIN customers cu ON cu."id" = c."contactId"
      WHERE c."companyId" = $1 ${statusFilter}
      ORDER BY c."lastMessageAt" DESC NULLS LAST
      LIMIT $2`,
    companyId,
    limit
  )) as any;
}

export async function getMessages(
  companyId: string,
  conversationId: string,
  limit = 100
): Promise<MessageRow[]> {
  return (await prisma.$queryRawUnsafe(
    `SELECT "id","conversationId","companyId","direction","externalMessageId","type","body","mediaUrl","status","errorDetail","sentByUserId","sentAt","createdAt"
       FROM messages WHERE "companyId" = $1 AND "conversationId" = $2
      ORDER BY "createdAt" ASC LIMIT $3`,
    companyId,
    conversationId,
    Math.min(Math.max(limit, 1), 500)
  )) as MessageRow[];
}

export async function markRead(companyId: string, conversationId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE conversations SET "unreadCount" = 0, "updatedAt" = NOW() WHERE "companyId" = $1 AND "id" = $2`,
    companyId,
    conversationId
  );
}

export async function attachDeal(
  companyId: string,
  conversationId: string,
  dealId: string | null
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE conversations SET "dealId" = $1, "updatedAt" = NOW() WHERE "companyId" = $2 AND "id" = $3`,
    dealId,
    companyId,
    conversationId
  );
}

/** Update a message's delivery status from a status webhook (by Meta msg id). */
export async function updateMessageStatusByExternalId(
  externalMessageId: string,
  status: string,
  errorDetail?: string | null
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE messages SET "status" = $1, "errorDetail" = $2 WHERE "externalMessageId" = $3`,
    status,
    errorDetail ?? null,
    externalMessageId
  );
}
