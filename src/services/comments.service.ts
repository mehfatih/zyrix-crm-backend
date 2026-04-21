// ============================================================================
// COMMENTS SERVICE
// ----------------------------------------------------------------------------
// Threaded comments attached to customers/deals/activities. Handles
// @mention parsing + notification fan-out atomically — a comment's
// mention rows are written in the same transaction as the comment
// itself, so a crash after insert can't leave mentions orphaned.
//
// Mention syntax: @[userId:Display Name] — the frontend mention picker
// inserts this wire format. We extract userIds with a regex and insert
// mention rows + notifications per mentioned user.
// ============================================================================

import { prisma } from "../config/database";
import { badRequest, notFound } from "../middleware/errorHandler";
import { createNotification } from "./notifications.service";

export type EntityType = "customer" | "deal" | "activity";

const VALID_ENTITY_TYPES: EntityType[] = ["customer", "deal", "activity"];

export interface CommentRow {
  id: string;
  companyId: string;
  authorId: string;
  entityType: string;
  entityId: string;
  body: string;
  parentId: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommentWithAuthor extends CommentRow {
  author: {
    id: string;
    fullName: string;
    email: string;
  };
  mentions: Array<{
    mentionedUserId: string;
  }>;
  replyCount: number;
}

// ──────────────────────────────────────────────────────────────────────
// @mention extraction
// ──────────────────────────────────────────────────────────────────────

const MENTION_RE = /@\[([a-f0-9-]+):([^\]]*)\]/gi;

/**
 * Extract userId list from a comment body using the @[uuid:Name] syntax.
 * Returns a dedup'd array — mentioning the same user twice in one
 * comment still produces one notification.
 */
export function extractMentions(body: string): string[] {
  const ids = new Set<string>();
  let match: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((match = MENTION_RE.exec(body)) !== null) {
    ids.add(match[1]);
  }
  return Array.from(ids);
}

/**
 * Resolve which mentioned userIds actually exist in the company —
 * prevents creating mentions for fake UUIDs or cross-tenant attempts.
 */
async function validateMentionedUsers(
  companyId: string,
  userIds: string[]
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id FROM users WHERE "companyId" = $1 AND id = ANY($2::text[])`,
    companyId,
    userIds
  )) as { id: string }[];
  return rows.map((r) => r.id);
}

// ──────────────────────────────────────────────────────────────────────
// Entity resolution — needed to build notification titles
// ──────────────────────────────────────────────────────────────────────

async function resolveEntityTitle(
  companyId: string,
  entityType: EntityType,
  entityId: string
): Promise<string> {
  if (entityType === "customer") {
    const c = await prisma.customer.findFirst({
      where: { id: entityId, companyId },
      select: { fullName: true, companyName: true },
    });
    if (!c) return "customer";
    return c.companyName ? `${c.fullName} (${c.companyName})` : c.fullName;
  }
  if (entityType === "deal") {
    const d = await prisma.deal.findFirst({
      where: { id: entityId, companyId },
      select: { title: true },
    });
    return d?.title ?? "deal";
  }
  if (entityType === "activity") {
    const a = await prisma.activity.findFirst({
      where: { id: entityId, companyId },
      select: { title: true, type: true },
    });
    return a ? `${a.type}: ${a.title}` : "activity";
  }
  return entityType;
}

function entityLink(
  entityType: EntityType,
  entityId: string,
  commentId: string
): string {
  const base =
    entityType === "customer"
      ? `/customers/${entityId}`
      : entityType === "deal"
        ? `/deals/${entityId}`
        : `/activities/${entityId}`;
  return `${base}?comment=${commentId}`;
}

// ──────────────────────────────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────────────────────────────

export interface CreateCommentInput {
  entityType: EntityType;
  entityId: string;
  body: string;
  parentId?: string;
}

export async function createComment(
  companyId: string,
  authorId: string,
  input: CreateCommentInput
): Promise<CommentWithAuthor> {
  if (!VALID_ENTITY_TYPES.includes(input.entityType)) {
    throw badRequest(`Invalid entityType. Must be one of: ${VALID_ENTITY_TYPES.join(", ")}`);
  }
  if (!input.body.trim() || input.body.length > 10000) {
    throw badRequest("Comment body must be 1-10000 chars");
  }

  // If it's a reply, verify parent exists + belongs to same entity
  if (input.parentId) {
    const parent = await prisma.comment.findFirst({
      where: { id: input.parentId, companyId },
      select: { entityType: true, entityId: true },
    });
    if (!parent) throw badRequest("Parent comment not found");
    if (parent.entityType !== input.entityType || parent.entityId !== input.entityId) {
      throw badRequest("Parent comment belongs to a different entity");
    }
  }

  // Extract + validate mentions
  const rawMentionIds = extractMentions(input.body);
  const validMentionIds = await validateMentionedUsers(companyId, rawMentionIds);

  // Look up author for notification fan-out
  const author = await prisma.user.findFirst({
    where: { id: authorId, companyId },
    select: { id: true, fullName: true, email: true },
  });
  if (!author) throw notFound("Author");

  // Insert comment + mentions atomically
  const comment = await prisma.$transaction(async (tx) => {
    const created = await tx.comment.create({
      data: {
        companyId,
        authorId,
        entityType: input.entityType,
        entityId: input.entityId,
        body: input.body.trim(),
        parentId: input.parentId ?? null,
      },
    });
    if (validMentionIds.length > 0) {
      await tx.mention.createMany({
        data: validMentionIds.map((mentionedUserId) => ({
          companyId,
          commentId: created.id,
          mentionedUserId,
        })),
        skipDuplicates: true,
      });
    }
    return created;
  });

  // Fire-and-forget notifications — mentions + parent-reply ping
  const entityTitle = await resolveEntityTitle(
    companyId,
    input.entityType,
    input.entityId
  );
  const link = entityLink(input.entityType, input.entityId, comment.id);
  const bodySnippet = comment.body.slice(0, 120);

  // Mention notifications (skip author if they @mentioned themselves)
  const mentionRecipients = validMentionIds.filter((id) => id !== authorId);
  for (const mentionedUserId of mentionRecipients) {
    createNotification({
      companyId,
      userId: mentionedUserId,
      kind: "mention",
      title: `${author.fullName} mentioned you on ${entityTitle}`,
      body: bodySnippet,
      link,
      entityType: input.entityType,
      entityId: input.entityId,
    }).catch(() => {
      /* non-critical — the comment itself saved successfully */
    });
  }

  // Reply notification — ping the parent's author if distinct from the
  // replier and not already mentioned (avoid double-pinging)
  if (input.parentId) {
    const parent = await prisma.comment.findFirst({
      where: { id: input.parentId },
      select: { authorId: true },
    });
    if (
      parent &&
      parent.authorId !== authorId &&
      !mentionRecipients.includes(parent.authorId)
    ) {
      createNotification({
        companyId,
        userId: parent.authorId,
        kind: "comment_reply",
        title: `${author.fullName} replied to your comment on ${entityTitle}`,
        body: bodySnippet,
        link,
        entityType: input.entityType,
        entityId: input.entityId,
      }).catch(() => {});
    }
  }

  return (await getCommentById(companyId, comment.id))!;
}

export async function listComments(
  companyId: string,
  entityType: EntityType,
  entityId: string
): Promise<CommentWithAuthor[]> {
  const comments = await prisma.comment.findMany({
    where: {
      companyId,
      entityType,
      entityId,
      deletedAt: null,
    },
    orderBy: { createdAt: "asc" },
    include: {
      mentions: { select: { mentionedUserId: true } },
    },
  });

  // Resolve authors in bulk
  const authorIds = Array.from(new Set(comments.map((c) => c.authorId)));
  const authors = authorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: authorIds } },
        select: { id: true, fullName: true, email: true },
      })
    : [];
  const authorMap = new Map(authors.map((a) => [a.id, a]));

  // Reply counts for each top-level comment
  const topLevel = comments.filter((c) => !c.parentId);
  const replyCounts = new Map<string, number>();
  for (const c of comments) {
    if (c.parentId) {
      replyCounts.set(c.parentId, (replyCounts.get(c.parentId) ?? 0) + 1);
    }
  }

  return comments.map((c) => ({
    ...c,
    createdAt: (c.createdAt as unknown as Date).toISOString(),
    updatedAt: (c.updatedAt as unknown as Date).toISOString(),
    editedAt: c.editedAt ? (c.editedAt as unknown as Date).toISOString() : null,
    deletedAt: c.deletedAt
      ? (c.deletedAt as unknown as Date).toISOString()
      : null,
    author: authorMap.get(c.authorId) ?? {
      id: c.authorId,
      fullName: "(unknown)",
      email: "",
    },
    replyCount: replyCounts.get(c.id) ?? 0,
  })) as unknown as CommentWithAuthor[];
}

export async function getCommentById(
  companyId: string,
  id: string
): Promise<CommentWithAuthor | null> {
  const c = await prisma.comment.findFirst({
    where: { id, companyId },
    include: {
      mentions: { select: { mentionedUserId: true } },
    },
  });
  if (!c) return null;
  const author = await prisma.user.findFirst({
    where: { id: c.authorId },
    select: { id: true, fullName: true, email: true },
  });
  const replyCount = await prisma.comment.count({
    where: { parentId: c.id },
  });
  return {
    ...c,
    createdAt: (c.createdAt as unknown as Date).toISOString(),
    updatedAt: (c.updatedAt as unknown as Date).toISOString(),
    editedAt: c.editedAt ? (c.editedAt as unknown as Date).toISOString() : null,
    deletedAt: c.deletedAt
      ? (c.deletedAt as unknown as Date).toISOString()
      : null,
    author: author ?? { id: c.authorId, fullName: "(unknown)", email: "" },
    replyCount,
  } as unknown as CommentWithAuthor;
}

export async function updateComment(
  companyId: string,
  authorId: string,
  id: string,
  body: string
): Promise<CommentWithAuthor> {
  if (!body.trim() || body.length > 10000) {
    throw badRequest("Body must be 1-10000 chars");
  }
  const existing = await prisma.comment.findFirst({
    where: { id, companyId, deletedAt: null },
  });
  if (!existing) throw notFound("Comment");
  if (existing.authorId !== authorId) {
    throw badRequest("You can only edit your own comments");
  }
  // Update body + replace mentions
  const newMentionIds = extractMentions(body);
  const valid = await validateMentionedUsers(companyId, newMentionIds);

  await prisma.$transaction(async (tx) => {
    await tx.comment.update({
      where: { id },
      data: { body: body.trim(), editedAt: new Date() },
    });
    await tx.mention.deleteMany({ where: { commentId: id } });
    if (valid.length > 0) {
      await tx.mention.createMany({
        data: valid.map((mentionedUserId) => ({
          companyId,
          commentId: id,
          mentionedUserId,
        })),
        skipDuplicates: true,
      });
    }
  });

  return (await getCommentById(companyId, id))!;
}

export async function deleteComment(
  companyId: string,
  authorId: string,
  id: string,
  userRole: string
): Promise<{ deleted: boolean }> {
  const existing = await prisma.comment.findFirst({
    where: { id, companyId, deletedAt: null },
  });
  if (!existing) throw notFound("Comment");
  // Author or admin/owner can delete
  const isPrivileged = userRole === "owner" || userRole === "admin";
  if (existing.authorId !== authorId && !isPrivileged) {
    throw badRequest("You can only delete your own comments");
  }
  // Soft delete so reply chains don't break visually
  await prisma.comment.update({
    where: { id },
    data: { deletedAt: new Date(), body: "[deleted]" },
  });
  return { deleted: true };
}
