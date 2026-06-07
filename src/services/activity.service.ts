import { prisma } from "../config/database";
import { notFound } from "../middleware/errorHandler";
import type { Prisma } from "@prisma/client";
import { dispatchActivityCompleted } from "./workflow-events.service";

export interface CreateActivityDto {
  type: "note" | "call" | "email" | "meeting" | "task" | "whatsapp";
  title: string;
  content?: string;
  customerId?: string;
  dealId?: string;
  dueDate?: string;
  metadata?: Record<string, unknown>;
  brandId?: string | null;
}

export async function createActivity(
  companyId: string,
  userId: string,
  dto: CreateActivityDto
) {
  // Resolve brandId with inheritance — an activity on a deal inherits
  // the deal's brand; an activity on just a customer inherits the
  // customer's brand. Explicit brandId always wins.
  let brandId: string | null = null;
  if (dto.brandId !== undefined && dto.brandId !== null) {
    const { assertBrandOwnedByCompany } = await import("./brands.service");
    await assertBrandOwnedByCompany(companyId, dto.brandId);
    brandId = dto.brandId;
  } else if (dto.brandId === undefined) {
    if (dto.dealId) {
      const deal = await prisma.deal.findFirst({
        where: { id: dto.dealId, companyId },
        select: { brandId: true },
      });
      brandId = deal?.brandId ?? null;
    } else if (dto.customerId) {
      const customer = await prisma.customer.findFirst({
        where: { id: dto.customerId, companyId },
        select: { brandId: true },
      });
      brandId = customer?.brandId ?? null;
    }
  }

  const created = await prisma.activity.create({
    data: {
      companyId,
      userId,
      brandId,
      type: dto.type,
      title: dto.title,
      content: dto.content,
      customerId: dto.customerId,
      dealId: dto.dealId,
      dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
      metadata: dto.metadata as Prisma.InputJsonValue,
    },
    include: {
      user: { select: { id: true, fullName: true } },
      customer: { select: { id: true, fullName: true } },
      deal: { select: { id: true, title: true } },
    },
  });

  // Sprint 21 — push meetings to Google Calendar (fire-and-forget, failure-safe).
  void syncMeetingOutbound(created, "upsert");
  return created;
}

// ── Calendar sync bridge (Sprint 21) ────────────────────────────────────────
// Fire-and-forget so a Google push never blocks (or fails) the meeting save.
// Dynamic import avoids a load-order cycle and keeps activities decoupled.
function syncMeetingOutbound(
  activity: { id: string; companyId: string; userId: string; type: string },
  op: "upsert" | "cancel"
): void {
  if (activity.type !== "meeting") return;
  void import("./calendar-sync.service")
    .then((mod) =>
      op === "cancel"
        ? mod.cancelMeetingForActivity(activity as never)
        : mod.pushMeetingForActivity(activity as never)
    )
    .catch(() => {});
}

export interface UpdateActivityDto {
  title?: string;
  content?: string | null;
  dueDate?: string | null;
  metadata?: Record<string, unknown>;
}

export async function updateActivity(
  companyId: string,
  activityId: string,
  dto: UpdateActivityDto
) {
  const existing = await prisma.activity.findFirst({
    where: { id: activityId, companyId },
  });
  if (!existing) throw notFound("Activity");

  const updated = await prisma.activity.update({
    where: { id: activityId },
    data: {
      ...(dto.title !== undefined && { title: dto.title }),
      ...(dto.content !== undefined && { content: dto.content }),
      ...(dto.dueDate !== undefined && { dueDate: dto.dueDate ? new Date(dto.dueDate) : null }),
      ...(dto.metadata !== undefined && { metadata: dto.metadata as Prisma.InputJsonValue }),
    },
    include: {
      user: { select: { id: true, fullName: true } },
      customer: { select: { id: true, fullName: true } },
      deal: { select: { id: true, title: true } },
    },
  });

  // Push the edit to Google (insert-or-patch by stamped googleEventId).
  void syncMeetingOutbound(updated, "upsert");
  return updated;
}

export async function listActivities(
  companyId: string,
  filters: {
    customerId?: string;
    dealId?: string;
    userId?: string;
    type?: string;
    brandId?: string;
    page?: number;
    limit?: number;
  } = {}
) {
  const { page = 1, limit = 20, ...rest } = filters;
  const skip = (page - 1) * limit;

  const where: Prisma.ActivityWhereInput = {
    companyId,
    ...(rest.customerId && { customerId: rest.customerId }),
    ...(rest.dealId && { dealId: rest.dealId }),
    ...(rest.userId && { userId: rest.userId }),
    ...(rest.type && { type: rest.type }),
    ...(rest.brandId === "unbranded"
      ? { brandId: null }
      : rest.brandId
        ? { brandId: rest.brandId }
        : {}),
  };

  const [activities, total] = await Promise.all([
    prisma.activity.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        user: { select: { id: true, fullName: true } },
        customer: { select: { id: true, fullName: true } },
        deal: { select: { id: true, title: true } },
      },
    }),
    prisma.activity.count({ where }),
  ]);

  return {
    activities,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

export async function completeActivity(
  companyId: string,
  activityId: string
) {
  const existing = await prisma.activity.findFirst({
    where: { id: activityId, companyId },
  });
  if (!existing) throw notFound("Activity");
  // Idempotency: if already completed, skip the update + dispatch so
  // re-hitting Complete doesn't cause duplicate workflow runs.
  if (existing.completedAt) return existing;

  const updated = await prisma.activity.update({
    where: { id: activityId },
    data: { completedAt: new Date() },
    include: {
      customer: {
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          status: true,
          source: true,
        },
      },
    },
  });

  dispatchActivityCompleted(
    companyId,
    {
      id: updated.id,
      type: updated.type,
      title: updated.title,
      customerId: updated.customerId,
    },
    updated.customer
      ? {
          id: updated.customer.id,
          fullName: updated.customer.fullName,
          email: updated.customer.email,
          phone: updated.customer.phone,
          status: updated.customer.status,
          source: updated.customer.source,
        }
      : null
  ).catch(() => {});

  return updated;
}

export async function deleteActivity(
  companyId: string,
  activityId: string
) {
  const existing = await prisma.activity.findFirst({
    where: { id: activityId, companyId },
  });
  if (!existing) throw notFound("Activity");

  await prisma.activity.delete({ where: { id: activityId } });
  // Sprint 21 — reflect the cancellation on Google (uses the stamped eventId).
  void syncMeetingOutbound(existing, "cancel");
  return { deleted: true };
}