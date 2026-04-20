import { prisma } from "../config/database";
import { notFound } from "../middleware/errorHandler";
import type { Prisma } from "@prisma/client";

// ============================================================================
// ADMIN — ANNOUNCEMENTS SERVICE
// ============================================================================

export interface AnnouncementListParams {
  page?: number;
  limit?: number;
  active?: boolean;
  target?: string;
}

export async function listAnnouncements(params: AnnouncementListParams) {
  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(100, Math.max(1, params.limit ?? 50));
  const skip = (page - 1) * limit;

  const where: Prisma.AnnouncementWhereInput = {};
  if (params.active !== undefined) where.isActive = params.active;
  if (params.target) where.target = params.target;

  const [total, items] = await Promise.all([
    prisma.announcement.count({ where }),
    prisma.announcement.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getAnnouncement(id: string) {
  const a = await prisma.announcement.findUnique({ where: { id } });
  if (!a) throw notFound("Announcement");
  return a;
}

export interface CreateAnnouncementDto {
  title: string;
  titleAr?: string;
  titleTr?: string;
  content: string;
  contentAr?: string;
  contentTr?: string;
  type?: string;
  target?: string;
  targetValue?: string;
  startsAt?: Date;
  endsAt?: Date | null;
  isActive?: boolean;
}

export async function createAnnouncement(
  actorUserId: string,
  dto: CreateAnnouncementDto
) {
  const created = await prisma.announcement.create({
    data: {
      title: dto.title,
      titleAr: dto.titleAr ?? null,
      titleTr: dto.titleTr ?? null,
      content: dto.content,
      contentAr: dto.contentAr ?? null,
      contentTr: dto.contentTr ?? null,
      type: dto.type ?? "info",
      target: dto.target ?? "all",
      targetValue: dto.targetValue ?? null,
      startsAt: dto.startsAt ?? new Date(),
      endsAt: dto.endsAt ?? null,
      isActive: dto.isActive ?? true,
      createdBy: actorUserId,
    },
  });

  await prisma.auditLog.create({
    data: {
      userId: actorUserId,
      action: "announcement.create",
      entityType: "announcement",
      entityId: created.id,
      metadata: { title: dto.title, type: created.type } as Prisma.InputJsonValue,
    },
  });

  return created;
}

export interface UpdateAnnouncementDto {
  title?: string;
  titleAr?: string | null;
  titleTr?: string | null;
  content?: string;
  contentAr?: string | null;
  contentTr?: string | null;
  type?: string;
  target?: string;
  targetValue?: string | null;
  startsAt?: Date;
  endsAt?: Date | null;
  isActive?: boolean;
}

export async function updateAnnouncement(
  id: string,
  actorUserId: string,
  dto: UpdateAnnouncementDto
) {
  const existing = await prisma.announcement.findUnique({ where: { id } });
  if (!existing) throw notFound("Announcement");

  const data: Prisma.AnnouncementUpdateInput = {};
  for (const [k, v] of Object.entries(dto)) {
    if (v !== undefined) (data as Record<string, unknown>)[k] = v;
  }

  const updated = await prisma.announcement.update({ where: { id }, data });

  await prisma.auditLog.create({
    data: {
      userId: actorUserId,
      action: "announcement.update",
      entityType: "announcement",
      entityId: id,
      metadata: { changed: Object.keys(dto) } as Prisma.InputJsonValue,
    },
  });

  return updated;
}

export async function deleteAnnouncement(id: string, actorUserId: string) {
  const existing = await prisma.announcement.findUnique({ where: { id } });
  if (!existing) throw notFound("Announcement");

  await prisma.announcement.delete({ where: { id } });

  await prisma.auditLog.create({
    data: {
      userId: actorUserId,
      action: "announcement.delete",
      entityType: "announcement",
      entityId: id,
      metadata: { title: existing.title } as Prisma.InputJsonValue,
    },
  });

  return { deleted: true };
}

// ─────────────────────────────────────────────────────────────────────────
// Public (for tenant dashboards to poll)
// ─────────────────────────────────────────────────────────────────────────
export async function getActivePublicAnnouncements(params: {
  plan?: string;
  companyId?: string;
}) {
  const now = new Date();
  const all = await prisma.announcement.findMany({
    where: {
      isActive: true,
      startsAt: { lte: now },
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
    },
    orderBy: { startsAt: "desc" },
  });

  // Apply targeting in-memory (small volume)
  return all.filter((a) => {
    if (a.target === "all") return true;
    if (a.target === "plan" && params.plan && a.targetValue === params.plan)
      return true;
    if (
      a.target === "company" &&
      params.companyId &&
      a.targetValue === params.companyId
    )
      return true;
    return false;
  });
}
