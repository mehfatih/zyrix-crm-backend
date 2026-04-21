import { prisma } from "../config/database";
import { notFound } from "../middleware/errorHandler";

// ============================================================================
// INTERNAL CHAT SERVICE (DMs only — channels TBD)
// ============================================================================

export interface SendMessageDto {
  toUserId: string;
  content: string;
}

// ─────────────────────────────────────────────────────────────────────────
// LIST THREADS — one row per conversation partner with last message + unread count
// ─────────────────────────────────────────────────────────────────────────
export async function listThreads(companyId: string, userId: string) {
  // Gather all users we've exchanged messages with
  const myMessages = await prisma.chatMessage.findMany({
    where: {
      companyId,
      OR: [{ fromUserId: userId }, { toUserId: userId }],
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      fromUserId: true,
      toUserId: true,
      content: true,
      readAt: true,
      createdAt: true,
    },
  });

  const partners = new Map<
    string,
    {
      partnerId: string;
      lastMessage: string;
      lastMessageAt: Date;
      lastFromMe: boolean;
      unread: number;
    }
  >();

  for (const m of myMessages) {
    const partnerId =
      m.fromUserId === userId ? m.toUserId : m.fromUserId;
    if (!partners.has(partnerId)) {
      partners.set(partnerId, {
        partnerId,
        lastMessage: m.content,
        lastMessageAt: m.createdAt,
        lastFromMe: m.fromUserId === userId,
        unread: 0,
      });
    }
    const entry = partners.get(partnerId)!;
    if (m.toUserId === userId && !m.readAt) {
      entry.unread++;
    }
  }

  const partnerIds = Array.from(partners.keys());
  const users = partnerIds.length
    ? await prisma.user.findMany({
        where: { id: { in: partnerIds }, companyId },
        select: { id: true, fullName: true, email: true, role: true },
      })
    : [];
  const userMap = new Map(users.map((u) => [u.id, u]));

  const threads = Array.from(partners.values())
    .filter((t) => userMap.has(t.partnerId))
    .map((t) => ({
      ...t,
      user: userMap.get(t.partnerId)!,
      lastMessageAt: t.lastMessageAt.toISOString(),
    }))
    .sort(
      (a, b) =>
        new Date(b.lastMessageAt).getTime() -
        new Date(a.lastMessageAt).getTime()
    );

  return threads;
}

// ─────────────────────────────────────────────────────────────────────────
// LIST TEAM — all users in company excluding self (to start a new DM)
// ─────────────────────────────────────────────────────────────────────────
export async function listTeam(companyId: string, userId: string) {
  return prisma.user.findMany({
    where: { companyId, id: { not: userId } },
    select: { id: true, fullName: true, email: true, role: true },
    orderBy: { fullName: "asc" },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// MESSAGES — between me and partner
// ─────────────────────────────────────────────────────────────────────────
export async function getConversation(
  companyId: string,
  userId: string,
  partnerId: string,
  opts: { since?: Date; limit?: number } = {}
) {
  const partner = await prisma.user.findFirst({
    where: { id: partnerId, companyId },
    select: { id: true, fullName: true, email: true, role: true },
  });
  if (!partner) throw notFound("User");

  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));

  const messages = await prisma.chatMessage.findMany({
    where: {
      companyId,
      OR: [
        { fromUserId: userId, toUserId: partnerId },
        { fromUserId: partnerId, toUserId: userId },
      ],
      ...(opts.since ? { createdAt: { gt: opts.since } } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  // Auto-mark received messages as read
  const unreadIds = messages
    .filter((m) => m.toUserId === userId && !m.readAt)
    .map((m) => m.id);
  if (unreadIds.length > 0) {
    await prisma.chatMessage.updateMany({
      where: { id: { in: unreadIds } },
      data: { readAt: new Date() },
    });
  }

  return { partner, messages };
}

// ─────────────────────────────────────────────────────────────────────────
// SEND MESSAGE
// ─────────────────────────────────────────────────────────────────────────
export async function sendMessage(
  companyId: string,
  userId: string,
  dto: SendMessageDto
) {
  const content = dto.content.trim();
  if (!content) {
    const err: any = new Error("Message cannot be empty");
    err.statusCode = 400;
    throw err;
  }
  if (content.length > 5000) {
    const err: any = new Error("Message too long (max 5000 chars)");
    err.statusCode = 400;
    throw err;
  }

  const recipient = await prisma.user.findFirst({
    where: { id: dto.toUserId, companyId },
    select: { id: true },
  });
  if (!recipient) throw notFound("Recipient");
  if (dto.toUserId === userId) {
    const err: any = new Error("Cannot send message to yourself");
    err.statusCode = 400;
    throw err;
  }

  return prisma.chatMessage.create({
    data: {
      companyId,
      fromUserId: userId,
      toUserId: dto.toUserId,
      content,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// UNREAD COUNT (total across all threads)
// ─────────────────────────────────────────────────────────────────────────
export async function getUnreadCount(companyId: string, userId: string) {
  const count = await prisma.chatMessage.count({
    where: { companyId, toUserId: userId, readAt: null },
  });
  return { unread: count };
}
