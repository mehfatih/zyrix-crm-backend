import { prisma } from "../config/database";
import { notFound } from "../middleware/errorHandler";
import type { Prisma } from "@prisma/client";

// ============================================================================
// CONTRACT SERVICE
// ============================================================================

export type ContractStatus =
  | "draft"
  | "pending_signature"
  | "signed"
  | "active"
  | "expired"
  | "terminated";

export interface CreateContractDto {
  customerId: string;
  dealId?: string | null;
  title: string;
  description?: string;
  status?: ContractStatus;
  startDate?: Date | null;
  endDate?: Date | null;
  renewalDate?: Date | null;
  signedAt?: Date | null;
  value?: number;
  currency?: string;
  fileUrl?: string;
  fileName?: string;
  notes?: string;
  terms?: string;
}

export interface UpdateContractDto extends Partial<CreateContractDto> {}

async function generateContractNumber(companyId: string): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `CT-${year}-`;
  const count = await prisma.contract.count({
    where: { companyId, contractNumber: { startsWith: prefix } },
  });
  const n = (count + 1).toString().padStart(4, "0");
  return `${prefix}${n}`;
}

// ─────────────────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────────────────
export async function listContracts(
  companyId: string,
  q: {
    status?: ContractStatus;
    customerId?: string;
    expiringWithinDays?: number;
    search?: string;
    page?: number;
    limit?: number;
  } = {}
) {
  const page = Math.max(1, q.page ?? 1);
  const limit = Math.min(200, Math.max(1, q.limit ?? 50));
  const skip = (page - 1) * limit;

  const where: Prisma.ContractWhereInput = { companyId };
  if (q.status) where.status = q.status;
  if (q.customerId) where.customerId = q.customerId;
  if (q.expiringWithinDays) {
    const cutoff = new Date(
      Date.now() + q.expiringWithinDays * 24 * 60 * 60 * 1000
    );
    where.endDate = { gte: new Date(), lte: cutoff };
    where.status = { in: ["active", "signed"] };
  }
  if (q.search) {
    where.OR = [
      { contractNumber: { contains: q.search, mode: "insensitive" } },
      { title: { contains: q.search, mode: "insensitive" } },
    ];
  }

  const [total, items] = await Promise.all([
    prisma.contract.count({ where }),
    prisma.contract.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        customer: {
          select: { id: true, fullName: true, companyName: true, email: true },
        },
        deal: { select: { id: true, title: true } },
        createdBy: { select: { id: true, fullName: true, email: true } },
      },
    }),
  ]);

  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getContract(companyId: string, id: string) {
  const c = await prisma.contract.findFirst({
    where: { id, companyId },
    include: {
      customer: {
        select: { id: true, fullName: true, companyName: true, email: true },
      },
      deal: { select: { id: true, title: true, stage: true } },
      createdBy: { select: { id: true, fullName: true, email: true } },
    },
  });
  if (!c) throw notFound("Contract");
  return c;
}

export async function createContract(
  companyId: string,
  userId: string,
  dto: CreateContractDto
) {
  const customer = await prisma.customer.findFirst({
    where: { id: dto.customerId, companyId },
    select: { id: true },
  });
  if (!customer) throw notFound("Customer");
  if (dto.dealId) {
    const d = await prisma.deal.findFirst({
      where: { id: dto.dealId, companyId },
      select: { id: true },
    });
    if (!d) throw notFound("Deal");
  }

  const contractNumber = await generateContractNumber(companyId);

  return prisma.contract.create({
    data: {
      companyId,
      customerId: dto.customerId,
      dealId: dto.dealId ?? null,
      createdById: userId,
      contractNumber,
      title: dto.title.trim(),
      description: dto.description?.trim() || null,
      status: dto.status ?? "draft",
      startDate: dto.startDate ?? null,
      endDate: dto.endDate ?? null,
      renewalDate: dto.renewalDate ?? null,
      signedAt: dto.signedAt ?? null,
      value: dto.value ?? 0,
      currency: dto.currency ?? "TRY",
      fileUrl: dto.fileUrl?.trim() || null,
      fileName: dto.fileName?.trim() || null,
      notes: dto.notes?.trim() || null,
      terms: dto.terms?.trim() || null,
    },
    include: {
      customer: {
        select: { id: true, fullName: true, companyName: true, email: true },
      },
      deal: { select: { id: true, title: true } },
      createdBy: { select: { id: true, fullName: true, email: true } },
    },
  });
}

export async function updateContract(
  companyId: string,
  id: string,
  dto: UpdateContractDto
) {
  const existing = await prisma.contract.findFirst({
    where: { id, companyId },
  });
  if (!existing) throw notFound("Contract");

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

  const data: Prisma.ContractUpdateInput = {};
  if (dto.title !== undefined) data.title = dto.title.trim();
  if (dto.description !== undefined)
    data.description = dto.description?.trim() || null;
  if (dto.status !== undefined) {
    data.status = dto.status;
    if (dto.status === "signed" && !existing.signedAt) {
      data.signedAt = new Date();
    }
  }
  if (dto.startDate !== undefined) data.startDate = dto.startDate;
  if (dto.endDate !== undefined) data.endDate = dto.endDate;
  if (dto.renewalDate !== undefined) data.renewalDate = dto.renewalDate;
  if (dto.signedAt !== undefined) data.signedAt = dto.signedAt;
  if (dto.value !== undefined) data.value = dto.value;
  if (dto.currency !== undefined) data.currency = dto.currency;
  if (dto.fileUrl !== undefined) data.fileUrl = dto.fileUrl?.trim() || null;
  if (dto.fileName !== undefined) data.fileName = dto.fileName?.trim() || null;
  if (dto.notes !== undefined) data.notes = dto.notes?.trim() || null;
  if (dto.terms !== undefined) data.terms = dto.terms?.trim() || null;
  if (dto.customerId !== undefined)
    data.customer = { connect: { id: dto.customerId } };
  if (dto.dealId !== undefined) {
    data.deal = dto.dealId ? { connect: { id: dto.dealId } } : { disconnect: true };
  }

  return prisma.contract.update({
    where: { id },
    data,
    include: {
      customer: {
        select: { id: true, fullName: true, companyName: true, email: true },
      },
      deal: { select: { id: true, title: true } },
      createdBy: { select: { id: true, fullName: true, email: true } },
    },
  });
}

export async function deleteContract(companyId: string, id: string) {
  const existing = await prisma.contract.findFirst({
    where: { id, companyId },
    select: { id: true },
  });
  if (!existing) throw notFound("Contract");
  await prisma.contract.delete({ where: { id } });
  return { deleted: true };
}

// ─────────────────────────────────────────────────────────────────────────
// CREATE RENEWAL REMINDER TASK
// ─────────────────────────────────────────────────────────────────────────
export async function createReminderTask(
  companyId: string,
  userId: string,
  contractId: string
) {
  const contract = await prisma.contract.findFirst({
    where: { id: contractId, companyId },
    include: {
      customer: { select: { id: true, fullName: true, companyName: true } },
    },
  });
  if (!contract) throw notFound("Contract");

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 1);

  const task = await prisma.task.create({
    data: {
      companyId,
      createdById: userId,
      customerId: contract.customerId,
      title: `Contract renewal: ${contract.title} (${contract.contractNumber})`,
      description: `Contract ${contract.contractNumber} expires on ${
        contract.endDate?.toISOString().slice(0, 10) ?? "—"
      }. Follow up with ${contract.customer.fullName}${contract.customer.companyName ? ` (${contract.customer.companyName})` : ""} to negotiate renewal.`,
      status: "todo",
      priority: "high",
      dueDate,
    },
  });

  await prisma.contract.update({
    where: { id: contractId },
    data: { reminderSent: true },
  });

  return task;
}

// ─────────────────────────────────────────────────────────────────────────
// STATS
// ─────────────────────────────────────────────────────────────────────────
export async function getStats(companyId: string) {
  const now = new Date();
  const thirtyFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const [total, draft, active, pending, expiringSoon, totalValue] =
    await Promise.all([
      prisma.contract.count({ where: { companyId } }),
      prisma.contract.count({ where: { companyId, status: "draft" } }),
      prisma.contract.count({
        where: { companyId, status: { in: ["active", "signed"] } },
      }),
      prisma.contract.count({
        where: { companyId, status: "pending_signature" },
      }),
      prisma.contract.count({
        where: {
          companyId,
          status: { in: ["active", "signed"] },
          endDate: { gte: now, lte: thirtyFromNow },
        },
      }),
      prisma.contract.aggregate({
        where: { companyId, status: { in: ["active", "signed"] } },
        _sum: { value: true },
      }),
    ]);

  return {
    total,
    byStatus: { draft, active, pending },
    expiringSoon,
    totalActiveValue: Number(totalValue._sum.value ?? 0),
  };
}
