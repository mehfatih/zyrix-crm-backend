import { prisma } from "../config/database";
import { notFound } from "../middleware/errorHandler";
import type { Prisma } from "@prisma/client";

// ============================================================================
// TASK SERVICE
// ============================================================================

export type TaskStatus = "todo" | "in_progress" | "done" | "cancelled";
export type TaskPriority = "low" | "medium" | "high" | "urgent";

export interface CreateTaskDto {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: Date | null;
  assignedToId?: string | null;
  customerId?: string | null;
  dealId?: string | null;
}

export interface UpdateTaskDto extends Partial<CreateTaskDto> {}

export interface ListTasksQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignedToId?: string; // 'me' to filter by current user
  customerId?: string;
  dealId?: string;
  dueBefore?: Date;
  dueAfter?: Date;
  overdueOnly?: boolean;
  sortBy?: "createdAt" | "dueDate" | "priority";
  sortOrder?: "asc" | "desc";
}

// ─────────────────────────────────────────────────────────────────────────
// CREATE
// ─────────────────────────────────────────────────────────────────────────
export async function createTask(
  companyId: string,
  userId: string,
  dto: CreateTaskDto
) {
  // Sanity-check relations belong to the same company (prevents tenant bleed)
  if (dto.customerId) {
    const c = await prisma.customer.findFirst({
      where: { id: dto.customerId, companyId },
      select: { id: true },
    });
    if (!c) throw notFound("Customer");
  }
  if (dto.dealId) {
    const d = await prisma.deal.findFirst({
      where: { id: dto.dealId, companyId },
      select: { id: true },
    });
    if (!d) throw notFound("Deal");
  }
  if (dto.assignedToId) {
    const u = await prisma.user.findFirst({
      where: { id: dto.assignedToId, companyId },
      select: { id: true },
    });
    if (!u) throw notFound("Assignee");
  }

  return prisma.task.create({
    data: {
      companyId,
      createdById: userId,
      assignedToId: dto.assignedToId ?? null,
      customerId: dto.customerId ?? null,
      dealId: dto.dealId ?? null,
      title: dto.title.trim(),
      description: dto.description?.trim() || null,
      status: dto.status ?? "todo",
      priority: dto.priority ?? "medium",
      dueDate: dto.dueDate ?? null,
    },
    include: taskInclude,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// LIST
// ─────────────────────────────────────────────────────────────────────────
export async function listTasks(
  companyId: string,
  userId: string,
  q: ListTasksQuery
) {
  const page = Math.max(1, q.page ?? 1);
  const limit = Math.min(100, Math.max(1, q.limit ?? 50));
  const skip = (page - 1) * limit;

  const where: Prisma.TaskWhereInput = { companyId };
  if (q.status) where.status = q.status;
  if (q.priority) where.priority = q.priority;
  if (q.customerId) where.customerId = q.customerId;
  if (q.dealId) where.dealId = q.dealId;

  if (q.assignedToId === "me") {
    where.assignedToId = userId;
  } else if (q.assignedToId) {
    where.assignedToId = q.assignedToId;
  }

  if (q.overdueOnly) {
    where.dueDate = { lt: new Date() };
    where.status = { in: ["todo", "in_progress"] };
  } else {
    if (q.dueBefore || q.dueAfter) {
      where.dueDate = {};
      if (q.dueBefore) (where.dueDate as Prisma.DateTimeFilter).lte = q.dueBefore;
      if (q.dueAfter) (where.dueDate as Prisma.DateTimeFilter).gte = q.dueAfter;
    }
  }

  if (q.search) {
    where.OR = [
      { title: { contains: q.search, mode: "insensitive" } },
      { description: { contains: q.search, mode: "insensitive" } },
    ];
  }

  const sortBy = q.sortBy ?? "createdAt";
  const sortOrder = q.sortOrder ?? "desc";

  let orderBy: Prisma.TaskOrderByWithRelationInput;
  if (sortBy === "priority") {
    // Priority sorts alphabetically which gives us low→medium→high→urgent —
    // that's accidentally useful for asc. For desc we'd want reversed.
    orderBy = { priority: sortOrder };
  } else if (sortBy === "dueDate") {
    orderBy = { dueDate: sortOrder };
  } else {
    orderBy = { createdAt: sortOrder };
  }

  const [total, items] = await Promise.all([
    prisma.task.count({ where }),
    prisma.task.findMany({
      where,
      skip,
      take: limit,
      orderBy,
      include: taskInclude,
    }),
  ]);

  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// GET ONE
// ─────────────────────────────────────────────────────────────────────────
export async function getTask(companyId: string, taskId: string) {
  const task = await prisma.task.findFirst({
    where: { id: taskId, companyId },
    include: taskInclude,
  });
  if (!task) throw notFound("Task");
  return task;
}

// ─────────────────────────────────────────────────────────────────────────
// UPDATE
// ─────────────────────────────────────────────────────────────────────────
export async function updateTask(
  companyId: string,
  taskId: string,
  dto: UpdateTaskDto
) {
  const existing = await prisma.task.findFirst({
    where: { id: taskId, companyId },
  });
  if (!existing) throw notFound("Task");

  const data: Prisma.TaskUpdateInput = {};
  if (dto.title !== undefined) data.title = dto.title.trim();
  if (dto.description !== undefined)
    data.description = dto.description?.trim() || null;
  if (dto.priority !== undefined) data.priority = dto.priority;
  if (dto.dueDate !== undefined) data.dueDate = dto.dueDate;

  if (dto.status !== undefined) {
    data.status = dto.status;
    if (dto.status === "done" && !existing.completedAt) {
      data.completedAt = new Date();
    } else if (dto.status !== "done" && existing.completedAt) {
      data.completedAt = null;
    }
  }

  if (dto.assignedToId !== undefined) {
    if (dto.assignedToId === null) {
      data.assignedTo = { disconnect: true };
    } else {
      const u = await prisma.user.findFirst({
        where: { id: dto.assignedToId, companyId },
        select: { id: true },
      });
      if (!u) throw notFound("Assignee");
      data.assignedTo = { connect: { id: dto.assignedToId } };
    }
  }

  if (dto.customerId !== undefined) {
    if (dto.customerId === null) {
      data.customer = { disconnect: true };
    } else {
      const c = await prisma.customer.findFirst({
        where: { id: dto.customerId, companyId },
        select: { id: true },
      });
      if (!c) throw notFound("Customer");
      data.customer = { connect: { id: dto.customerId } };
    }
  }

  if (dto.dealId !== undefined) {
    if (dto.dealId === null) {
      data.deal = { disconnect: true };
    } else {
      const d = await prisma.deal.findFirst({
        where: { id: dto.dealId, companyId },
        select: { id: true },
      });
      if (!d) throw notFound("Deal");
      data.deal = { connect: { id: dto.dealId } };
    }
  }

  return prisma.task.update({
    where: { id: taskId },
    data,
    include: taskInclude,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────────────────────────────────
export async function deleteTask(companyId: string, taskId: string) {
  const existing = await prisma.task.findFirst({
    where: { id: taskId, companyId },
    select: { id: true },
  });
  if (!existing) throw notFound("Task");
  await prisma.task.delete({ where: { id: taskId } });
  return { deleted: true };
}

// ─────────────────────────────────────────────────────────────────────────
// STATS
// ─────────────────────────────────────────────────────────────────────────
export async function getTaskStats(companyId: string, userId: string) {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const [
    totalOpen,
    myOpen,
    overdue,
    dueToday,
    todo,
    inProgress,
    done,
    cancelled,
    urgent,
  ] = await Promise.all([
    prisma.task.count({
      where: { companyId, status: { in: ["todo", "in_progress"] } },
    }),
    prisma.task.count({
      where: {
        companyId,
        assignedToId: userId,
        status: { in: ["todo", "in_progress"] },
      },
    }),
    prisma.task.count({
      where: {
        companyId,
        status: { in: ["todo", "in_progress"] },
        dueDate: { lt: now },
      },
    }),
    prisma.task.count({
      where: {
        companyId,
        status: { in: ["todo", "in_progress"] },
        dueDate: { gte: now, lt: tomorrow },
      },
    }),
    prisma.task.count({ where: { companyId, status: "todo" } }),
    prisma.task.count({ where: { companyId, status: "in_progress" } }),
    prisma.task.count({ where: { companyId, status: "done" } }),
    prisma.task.count({ where: { companyId, status: "cancelled" } }),
    prisma.task.count({
      where: {
        companyId,
        priority: "urgent",
        status: { in: ["todo", "in_progress"] },
      },
    }),
  ]);

  return {
    totalOpen,
    myOpen,
    overdue,
    dueToday,
    byStatus: { todo, inProgress, done, cancelled },
    urgent,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Shared include clause
// ─────────────────────────────────────────────────────────────────────────
const taskInclude = {
  createdBy: { select: { id: true, email: true, fullName: true } },
  assignedTo: { select: { id: true, email: true, fullName: true } },
  customer: { select: { id: true, fullName: true, companyName: true } },
  deal: { select: { id: true, title: true } },
} satisfies Prisma.TaskInclude;
