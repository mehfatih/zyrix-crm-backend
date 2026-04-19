import { prisma } from "../config/database";
import { notFound } from "../middleware/errorHandler";
import type { Prisma } from "@prisma/client";

export interface CreateActivityDto {
  type: "note" | "call" | "email" | "meeting" | "task" | "whatsapp";
  title: string;
  content?: string;
  customerId?: string;
  dealId?: string;
  dueDate?: string;
  metadata?: Record<string, unknown>;
}

export async function createActivity(
  companyId: string,
  userId: string,
  dto: CreateActivityDto
) {
  return prisma.activity.create({
    data: {
      companyId,
      userId,
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
}

export async function listActivities(
  companyId: string,
  filters: {
    customerId?: string;
    dealId?: string;
    userId?: string;
    type?: string;
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

  return prisma.activity.update({
    where: { id: activityId },
    data: { completedAt: new Date() },
  });
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
  return { deleted: true };
}