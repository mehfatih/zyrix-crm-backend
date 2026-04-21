import { prisma } from "../config/database";
import { badRequest, notFound } from "../middleware/errorHandler";
import type { Prisma } from "@prisma/client";
import {
  dispatchCustomerCreated,
  dispatchCustomerStatusChanged,
} from "./workflow-events.service";

export interface CreateCustomerDto {
  fullName: string;
  email?: string;
  phone?: string;
  whatsappPhone?: string;
  companyName?: string;
  position?: string;
  country?: string;
  city?: string;
  address?: string;
  source?: string;
  status?: string;
  notes?: string;
}

export interface UpdateCustomerDto extends Partial<CreateCustomerDto> {
  ownerId?: string | null;
  lifetimeValue?: number;
}

export interface ListCustomersQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: string;
  ownerId?: string;
  sortBy?: "createdAt" | "fullName" | "lifetimeValue";
  sortOrder?: "asc" | "desc";
}

// ─────────────────────────────────────────────────────────────────────────
// CREATE
// ─────────────────────────────────────────────────────────────────────────
export async function createCustomer(
  companyId: string,
  userId: string,
  dto: CreateCustomerDto
) {
  if (dto.email) {
    const existing = await prisma.customer.findFirst({
      where: { companyId, email: dto.email.toLowerCase() },
    });
    if (existing) {
      throw badRequest("A customer with this email already exists");
    }
  }

  const customer = await prisma.customer.create({
    data: {
      companyId,
      ownerId: userId,
      fullName: dto.fullName,
      email: dto.email?.toLowerCase(),
      phone: dto.phone,
      whatsappPhone: dto.whatsappPhone || dto.phone,
      companyName: dto.companyName,
      position: dto.position,
      country: dto.country,
      city: dto.city,
      address: dto.address,
      source: dto.source || "manual",
      status: dto.status || "new",
      notes: dto.notes,
    },
    include: {
      owner: { select: { id: true, fullName: true, email: true } },
      _count: { select: { deals: true, activities: true } },
    },
  });

  // Fire workflow triggers. dispatchCustomerCreated is fire-and-forget;
  // the customer is already persisted, so any error in workflow matching
  // can't roll back the primary action.
  dispatchCustomerCreated(companyId, {
    id: customer.id,
    fullName: customer.fullName,
    email: customer.email,
    phone: customer.phone,
    status: customer.status,
    source: customer.source,
  }).catch(() => {
    /* already logged inside safeDispatch */
  });

  return customer;
}

// ─────────────────────────────────────────────────────────────────────────
// LIST (paginated + filtered)
// ─────────────────────────────────────────────────────────────────────────
export async function listCustomers(
  companyId: string,
  query: ListCustomersQuery = {}
) {
  const {
    page = 1,
    limit = 20,
    search,
    status,
    ownerId,
    sortBy = "createdAt",
    sortOrder = "desc",
  } = query;

  const skip = (page - 1) * limit;

  const where: Prisma.CustomerWhereInput = {
    companyId,
    ...(status && { status }),
    ...(ownerId && { ownerId }),
    ...(search && {
      OR: [
        { fullName: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { phone: { contains: search } },
        { companyName: { contains: search, mode: "insensitive" } },
      ],
    }),
  };

  const [customers, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      skip,
      take: limit,
      orderBy: { [sortBy]: sortOrder },
      include: {
        owner: { select: { id: true, fullName: true, email: true } },
        _count: { select: { deals: true, activities: true } },
      },
    }),
    prisma.customer.count({ where }),
  ]);

  return {
    customers,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// GET BY ID
// ─────────────────────────────────────────────────────────────────────────
export async function getCustomerById(companyId: string, customerId: string) {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, companyId },
    include: {
      owner: { select: { id: true, fullName: true, email: true } },
      deals: {
        orderBy: { createdAt: "desc" },
        take: 10,
        include: { owner: { select: { id: true, fullName: true } } },
      },
      activities: {
        orderBy: { createdAt: "desc" },
        take: 20,
        include: { user: { select: { id: true, fullName: true } } },
      },
      tags: { include: { tag: true } },
      _count: {
        select: { deals: true, activities: true, whatsappChats: true },
      },
    },
  });

  if (!customer) throw notFound("Customer");
  return customer;
}

// ─────────────────────────────────────────────────────────────────────────
// UPDATE
// ─────────────────────────────────────────────────────────────────────────
export async function updateCustomer(
  companyId: string,
  customerId: string,
  dto: UpdateCustomerDto
) {
  const existing = await prisma.customer.findFirst({
    where: { id: customerId, companyId },
  });
  if (!existing) throw notFound("Customer");

  const updated = await prisma.customer.update({
    where: { id: customerId },
    data: {
      ...(dto.fullName !== undefined && { fullName: dto.fullName }),
      ...(dto.email !== undefined && {
        email: dto.email ? dto.email.toLowerCase() : null,
      }),
      ...(dto.phone !== undefined && { phone: dto.phone }),
      ...(dto.whatsappPhone !== undefined && {
        whatsappPhone: dto.whatsappPhone,
      }),
      ...(dto.companyName !== undefined && { companyName: dto.companyName }),
      ...(dto.position !== undefined && { position: dto.position }),
      ...(dto.country !== undefined && { country: dto.country }),
      ...(dto.city !== undefined && { city: dto.city }),
      ...(dto.address !== undefined && { address: dto.address }),
      ...(dto.source !== undefined && { source: dto.source }),
      ...(dto.status !== undefined && { status: dto.status }),
      ...(dto.notes !== undefined && { notes: dto.notes }),
      ...(dto.ownerId !== undefined && { ownerId: dto.ownerId }),
      ...(dto.lifetimeValue !== undefined && {
        lifetimeValue: dto.lifetimeValue,
      }),
    },
    include: {
      owner: { select: { id: true, fullName: true, email: true } },
      _count: { select: { deals: true, activities: true } },
    },
  });

  // Fire status-changed event only when status actually changed.
  // Workflows can filter on the new status via trigger.config.toStatus.
  if (dto.status !== undefined && dto.status !== existing.status) {
    dispatchCustomerStatusChanged(
      companyId,
      {
        id: updated.id,
        fullName: updated.fullName,
        email: updated.email,
        phone: updated.phone,
        status: updated.status,
        source: updated.source,
      },
      existing.status
    ).catch(() => {});
  }

  return updated;
}

// ─────────────────────────────────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────────────────────────────────
export async function deleteCustomer(companyId: string, customerId: string) {
  const existing = await prisma.customer.findFirst({
    where: { id: customerId, companyId },
  });
  if (!existing) throw notFound("Customer");

  await prisma.customer.delete({ where: { id: customerId } });
  return { deleted: true };
}

// ─────────────────────────────────────────────────────────────────────────
// STATS
// ─────────────────────────────────────────────────────────────────────────
export async function getCustomerStats(companyId: string) {
  const [total, byStatus, recent] = await Promise.all([
    prisma.customer.count({ where: { companyId } }),
    prisma.customer.groupBy({
      by: ["status"],
      where: { companyId },
      _count: true,
    }),
    prisma.customer.count({
      where: {
        companyId,
        createdAt: {
          gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        },
      },
    }),
  ]);

  return {
    total,
    recent30Days: recent,
    byStatus: byStatus.reduce(
      (acc, item) => ({ ...acc, [item.status]: item._count }),
      {} as Record<string, number>
    ),
  };
}