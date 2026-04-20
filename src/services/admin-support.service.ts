import { prisma } from "../config/database";
import { notFound } from "../middleware/errorHandler";
import type { Prisma } from "@prisma/client";

// ============================================================================
// ADMIN — SUPPORT TICKETS SERVICE
// ============================================================================

export interface TicketListParams {
  page?: number;
  limit?: number;
  status?: string;
  priority?: string;
  category?: string;
  companyId?: string;
  assignedToId?: string;
}

export async function listTickets(params: TicketListParams) {
  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(100, Math.max(1, params.limit ?? 50));
  const skip = (page - 1) * limit;

  const where: Prisma.SupportTicketWhereInput = {};
  if (params.status) where.status = params.status;
  if (params.priority) where.priority = params.priority;
  if (params.category) where.category = params.category;
  if (params.companyId) where.companyId = params.companyId;
  if (params.assignedToId) where.assignedToId = params.assignedToId;

  const [total, items] = await Promise.all([
    prisma.supportTicket.count({ where }),
    prisma.supportTicket.findMany({
      where,
      skip,
      take: limit,
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      include: {
        company: { select: { id: true, name: true, slug: true, plan: true } },
        createdBy: { select: { id: true, email: true, fullName: true } },
        assignedTo: { select: { id: true, email: true, fullName: true } },
      },
    }),
  ]);

  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getTicket(id: string) {
  const t = await prisma.supportTicket.findUnique({
    where: { id },
    include: {
      company: { select: { id: true, name: true, slug: true, plan: true } },
      createdBy: { select: { id: true, email: true, fullName: true } },
      assignedTo: { select: { id: true, email: true, fullName: true } },
    },
  });
  if (!t) throw notFound("Ticket");
  return t;
}

export interface UpdateTicketDto {
  status?: string;
  priority?: string;
  category?: string;
  assignedToId?: string | null;
}

export async function updateTicket(
  id: string,
  actorUserId: string,
  dto: UpdateTicketDto
) {
  const existing = await prisma.supportTicket.findUnique({ where: { id } });
  if (!existing) throw notFound("Ticket");

  const data: Prisma.SupportTicketUpdateInput = {};
  if (dto.status !== undefined) {
    data.status = dto.status;
    if (dto.status === "resolved" && !existing.resolvedAt)
      data.resolvedAt = new Date();
    if (dto.status === "closed" && !existing.closedAt)
      data.closedAt = new Date();
  }
  if (dto.priority !== undefined) data.priority = dto.priority;
  if (dto.category !== undefined) data.category = dto.category;
  if (dto.assignedToId !== undefined) {
    if (dto.assignedToId === null) {
      data.assignedTo = { disconnect: true };
    } else {
      data.assignedTo = { connect: { id: dto.assignedToId } };
    }
  }

  const updated = await prisma.supportTicket.update({
    where: { id },
    data,
    include: {
      company: { select: { id: true, name: true, slug: true, plan: true } },
      createdBy: { select: { id: true, email: true, fullName: true } },
      assignedTo: { select: { id: true, email: true, fullName: true } },
    },
  });

  await prisma.auditLog.create({
    data: {
      userId: actorUserId,
      action: "ticket.update",
      entityType: "ticket",
      entityId: id,
      metadata: { changed: Object.keys(dto) } as Prisma.InputJsonValue,
    },
  });

  return updated;
}

export async function assignTicket(
  id: string,
  actorUserId: string,
  assigneeId: string
) {
  return updateTicket(id, actorUserId, { assignedToId: assigneeId });
}

export async function closeTicket(id: string, actorUserId: string) {
  return updateTicket(id, actorUserId, { status: "closed" });
}

export async function getTicketStats() {
  const [open, inProgress, resolved, closed, urgent] = await Promise.all([
    prisma.supportTicket.count({ where: { status: "open" } }),
    prisma.supportTicket.count({ where: { status: "in_progress" } }),
    prisma.supportTicket.count({ where: { status: "resolved" } }),
    prisma.supportTicket.count({ where: { status: "closed" } }),
    prisma.supportTicket.count({
      where: { priority: "urgent", status: { in: ["open", "in_progress"] } },
    }),
  ]);

  return { open, inProgress, resolved, closed, urgent };
}
