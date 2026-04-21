// ============================================================================
// NOTIFICATIONS SERVICE
// ----------------------------------------------------------------------------
// In-app notification CRUD. Anyone who needs to ping a user (mention
// handler, deal-assigned handler, comment-reply handler) calls
// createNotification — it inserts a row the bell tray will pick up.
// ============================================================================

import { prisma } from "../config/database";

export interface NotificationRow {
  id: string;
  companyId: string;
  userId: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  entityType: string | null;
  entityId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface CreateNotificationInput {
  companyId: string;
  userId: string;
  kind: string;
  title: string;
  body?: string;
  link?: string;
  entityType?: string;
  entityId?: string;
}

export async function createNotification(
  input: CreateNotificationInput
): Promise<NotificationRow> {
  const rows = (await prisma.$queryRawUnsafe(
    `INSERT INTO notifications
       (id, "companyId", "userId", kind, title, body, link, "entityType", "entityId", "createdAt")
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, NOW())
     RETURNING id, "companyId", "userId", kind, title, body, link, "entityType", "entityId",
               "readAt", "createdAt"`,
    input.companyId,
    input.userId,
    input.kind,
    input.title,
    input.body ?? null,
    input.link ?? null,
    input.entityType ?? null,
    input.entityId ?? null
  )) as NotificationRow[];
  return rows[0];
}

/**
 * Batch-create notifications for multiple recipients sharing the same
 * payload (e.g. a deal assigned to a team of three — three rows with
 * the same title/body/link differing only in userId). Done in a single
 * SQL to minimize round-trips.
 */
export async function createBulkNotifications(
  companyId: string,
  userIds: string[],
  payload: Omit<CreateNotificationInput, "companyId" | "userId">
): Promise<number> {
  if (userIds.length === 0) return 0;

  // Generate bulk VALUES clause. Each user gets 9 params; we join with
  // indexed placeholders like ($1, $2, $3, ...).
  const rows = userIds.map((userId, i) => {
    const base = i * 8;
    return `(gen_random_uuid(), $${base + 1}, $${base + 2}, $${base + 3}, $${
      base + 4
    }, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, NOW())`;
  });
  const values: any[] = [];
  for (const userId of userIds) {
    values.push(
      companyId,
      userId,
      payload.kind,
      payload.title,
      payload.body ?? null,
      payload.link ?? null,
      payload.entityType ?? null,
      payload.entityId ?? null
    );
  }
  await prisma.$executeRawUnsafe(
    `INSERT INTO notifications
       (id, "companyId", "userId", kind, title, body, link, "entityType", "entityId", "createdAt")
     VALUES ${rows.join(", ")}`,
    ...values
  );
  return userIds.length;
}

export async function listNotifications(
  companyId: string,
  userId: string,
  opts: { onlyUnread?: boolean; limit?: number; offset?: number } = {}
) {
  const limit = Math.min(opts.limit ?? 50, 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const params: any[] = [companyId, userId];
  let whereClause = `"companyId" = $1 AND "userId" = $2`;
  if (opts.onlyUnread) {
    whereClause += ` AND "readAt" IS NULL`;
  }
  params.push(limit, offset);
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id, "companyId", "userId", kind, title, body, link, "entityType",
            "entityId", "readAt", "createdAt"
     FROM notifications
     WHERE ${whereClause}
     ORDER BY "createdAt" DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    ...params
  )) as NotificationRow[];
  return rows;
}

export async function getUnreadCount(
  companyId: string,
  userId: string
): Promise<number> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count FROM notifications
     WHERE "companyId" = $1 AND "userId" = $2 AND "readAt" IS NULL`,
    companyId,
    userId
  )) as { count: number }[];
  return rows[0]?.count ?? 0;
}

export async function markAsRead(
  companyId: string,
  userId: string,
  ids: string[]
): Promise<{ updated: number }> {
  if (ids.length === 0) return { updated: 0 };
  const placeholders = ids.map((_, i) => `$${i + 3}`).join(", ");
  const result = await prisma.$executeRawUnsafe(
    `UPDATE notifications SET "readAt" = NOW()
     WHERE "companyId" = $1 AND "userId" = $2 AND id IN (${placeholders})
       AND "readAt" IS NULL`,
    companyId,
    userId,
    ...ids
  );
  return { updated: Number(result) };
}

export async function markAllAsRead(
  companyId: string,
  userId: string
): Promise<{ updated: number }> {
  const result = await prisma.$executeRawUnsafe(
    `UPDATE notifications SET "readAt" = NOW()
     WHERE "companyId" = $1 AND "userId" = $2 AND "readAt" IS NULL`,
    companyId,
    userId
  );
  return { updated: Number(result) };
}

export async function deleteNotification(
  companyId: string,
  userId: string,
  id: string
): Promise<{ deleted: boolean }> {
  const rows = (await prisma.$queryRawUnsafe(
    `DELETE FROM notifications
     WHERE id = $1 AND "companyId" = $2 AND "userId" = $3
     RETURNING id`,
    id,
    companyId,
    userId
  )) as { id: string }[];
  return { deleted: rows.length > 0 };
}
