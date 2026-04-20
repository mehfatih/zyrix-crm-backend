import { prisma } from "../config/database";
import { notFound } from "../middleware/errorHandler";
import type { Prisma } from "@prisma/client";
import { randomBytes } from "crypto";

// ============================================================================
// QUOTE SERVICE
// ============================================================================

export type QuoteStatus =
  | "draft"
  | "sent"
  | "viewed"
  | "accepted"
  | "rejected"
  | "expired";

export interface QuoteItemInput {
  name: string;
  description?: string | null;
  quantity: number;
  unitPrice: number;
  discountPercent?: number;
  taxPercent?: number;
  position?: number;
}

export interface CreateQuoteDto {
  customerId: string;
  dealId?: string | null;
  title: string;
  status?: QuoteStatus;
  currency?: string;
  issuedAt?: Date | null;
  validUntil?: Date | null;
  notes?: string | null;
  terms?: string | null;
  items: QuoteItemInput[];
}

export interface UpdateQuoteDto {
  customerId?: string;
  dealId?: string | null;
  title?: string;
  status?: QuoteStatus;
  currency?: string;
  issuedAt?: Date | null;
  validUntil?: Date | null;
  notes?: string | null;
  terms?: string | null;
  items?: QuoteItemInput[];
}

export interface ListQuotesQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: QuoteStatus;
  customerId?: string;
  dealId?: string;
  createdById?: string;
  sortBy?: "createdAt" | "validUntil" | "total" | "quoteNumber";
  sortOrder?: "asc" | "desc";
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────
function computeLineTotal(item: QuoteItemInput): {
  lineTotal: number;
  taxForLine: number;
  subtotalForLine: number;
} {
  const qty = Number(item.quantity) || 0;
  const unit = Number(item.unitPrice) || 0;
  const discount = Number(item.discountPercent) || 0;
  const tax = Number(item.taxPercent) || 0;

  const gross = qty * unit;
  const afterDiscount = gross * (1 - discount / 100);
  const taxForLine = afterDiscount * (tax / 100);
  const lineTotal = afterDiscount + taxForLine;

  return {
    lineTotal: Math.round(lineTotal * 100) / 100,
    taxForLine: Math.round(taxForLine * 100) / 100,
    subtotalForLine: Math.round(afterDiscount * 100) / 100,
  };
}

function computeTotals(items: QuoteItemInput[]): {
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  total: number;
} {
  let subtotal = 0;
  let discountAmount = 0;
  let taxAmount = 0;

  for (const item of items) {
    const qty = Number(item.quantity) || 0;
    const unit = Number(item.unitPrice) || 0;
    const gross = qty * unit;
    const discount = gross * ((Number(item.discountPercent) || 0) / 100);
    const afterDiscount = gross - discount;
    const tax = afterDiscount * ((Number(item.taxPercent) || 0) / 100);

    subtotal += afterDiscount;
    discountAmount += discount;
    taxAmount += tax;
  }

  const total = subtotal + taxAmount;

  return {
    subtotal: Math.round(subtotal * 100) / 100,
    discountAmount: Math.round(discountAmount * 100) / 100,
    taxAmount: Math.round(taxAmount * 100) / 100,
    total: Math.round(total * 100) / 100,
  };
}

async function generateQuoteNumber(companyId: string): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `Q-${year}-`;
  const count = await prisma.quote.count({
    where: { companyId, quoteNumber: { startsWith: prefix } },
  });
  const n = (count + 1).toString().padStart(4, "0");
  return `${prefix}${n}`;
}

function generatePublicToken(): string {
  return randomBytes(24).toString("hex");
}

// ─────────────────────────────────────────────────────────────────────────
// CREATE
// ─────────────────────────────────────────────────────────────────────────
export async function createQuote(
  companyId: string,
  userId: string,
  dto: CreateQuoteDto
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

  if (!dto.items || dto.items.length === 0) {
    const err: any = new Error("Quote must have at least one item");
    err.statusCode = 400;
    throw err;
  }

  const totals = computeTotals(dto.items);
  const quoteNumber = await generateQuoteNumber(companyId);
  const publicToken = generatePublicToken();

  const created = await prisma.quote.create({
    data: {
      companyId,
      customerId: dto.customerId,
      dealId: dto.dealId ?? null,
      createdById: userId,
      quoteNumber,
      title: dto.title.trim(),
      status: dto.status ?? "draft",
      currency: dto.currency ?? "TRY",
      issuedAt: dto.issuedAt ?? new Date(),
      validUntil: dto.validUntil ?? null,
      notes: dto.notes?.trim() || null,
      terms: dto.terms?.trim() || null,
      publicToken,
      subtotal: totals.subtotal,
      discountAmount: totals.discountAmount,
      taxAmount: totals.taxAmount,
      total: totals.total,
      items: {
        create: dto.items.map((it, idx) => {
          const { lineTotal } = computeLineTotal(it);
          return {
            name: it.name.trim(),
            description: it.description?.trim() || null,
            quantity: it.quantity,
            unitPrice: it.unitPrice,
            discountPercent: it.discountPercent ?? 0,
            taxPercent: it.taxPercent ?? 0,
            lineTotal,
            position: it.position ?? idx,
          };
        }),
      },
    },
    include: quoteInclude,
  });

  return created;
}

// ─────────────────────────────────────────────────────────────────────────
// LIST
// ─────────────────────────────────────────────────────────────────────────
export async function listQuotes(companyId: string, q: ListQuotesQuery) {
  const page = Math.max(1, q.page ?? 1);
  const limit = Math.min(100, Math.max(1, q.limit ?? 50));
  const skip = (page - 1) * limit;

  const where: Prisma.QuoteWhereInput = { companyId };
  if (q.status) where.status = q.status;
  if (q.customerId) where.customerId = q.customerId;
  if (q.dealId) where.dealId = q.dealId;
  if (q.createdById) where.createdById = q.createdById;

  if (q.search) {
    where.OR = [
      { quoteNumber: { contains: q.search, mode: "insensitive" } },
      { title: { contains: q.search, mode: "insensitive" } },
    ];
  }

  const sortBy = q.sortBy ?? "createdAt";
  const sortOrder = q.sortOrder ?? "desc";

  const orderBy: Prisma.QuoteOrderByWithRelationInput =
    sortBy === "validUntil"
      ? { validUntil: sortOrder }
      : sortBy === "total"
        ? { total: sortOrder }
        : sortBy === "quoteNumber"
          ? { quoteNumber: sortOrder }
          : { createdAt: sortOrder };

  const [total, items] = await Promise.all([
    prisma.quote.count({ where }),
    prisma.quote.findMany({
      where,
      skip,
      take: limit,
      orderBy,
      include: quoteInclude,
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
export async function getQuote(companyId: string, quoteId: string) {
  const quote = await prisma.quote.findFirst({
    where: { id: quoteId, companyId },
    include: quoteInclude,
  });
  if (!quote) throw notFound("Quote");
  return quote;
}

// ─────────────────────────────────────────────────────────────────────────
// GET BY PUBLIC TOKEN (customer-facing, no auth)
// ─────────────────────────────────────────────────────────────────────────
export async function getQuoteByPublicToken(token: string) {
  const quote = await prisma.quote.findUnique({
    where: { publicToken: token },
    include: {
      customer: { select: { id: true, fullName: true, companyName: true, email: true } },
      company: { select: { id: true, name: true, billingEmail: true } },
      items: { orderBy: { position: "asc" } },
    },
  });
  if (!quote) throw notFound("Quote");

  // Mark viewed on first access
  if (!quote.viewedAt) {
    await prisma.quote.update({
      where: { id: quote.id },
      data: {
        viewedAt: new Date(),
        status: quote.status === "sent" ? "viewed" : quote.status,
      },
    });
  }

  return quote;
}

// ─────────────────────────────────────────────────────────────────────────
// UPDATE
// ─────────────────────────────────────────────────────────────────────────
export async function updateQuote(
  companyId: string,
  quoteId: string,
  dto: UpdateQuoteDto
) {
  const existing = await prisma.quote.findFirst({
    where: { id: quoteId, companyId },
  });
  if (!existing) throw notFound("Quote");

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

  const data: Prisma.QuoteUpdateInput = {};
  if (dto.title !== undefined) data.title = dto.title.trim();
  if (dto.status !== undefined) {
    data.status = dto.status;
    if (dto.status === "sent" && !existing.sentAt) data.sentAt = new Date();
    if (dto.status === "accepted" && !existing.acceptedAt)
      data.acceptedAt = new Date();
    if (dto.status === "rejected" && !existing.rejectedAt)
      data.rejectedAt = new Date();
  }
  if (dto.currency !== undefined) data.currency = dto.currency;
  if (dto.issuedAt !== undefined) data.issuedAt = dto.issuedAt;
  if (dto.validUntil !== undefined) data.validUntil = dto.validUntil;
  if (dto.notes !== undefined) data.notes = dto.notes?.trim() || null;
  if (dto.terms !== undefined) data.terms = dto.terms?.trim() || null;

  if (dto.customerId !== undefined)
    data.customer = { connect: { id: dto.customerId } };

  if (dto.dealId !== undefined) {
    if (dto.dealId === null) {
      data.deal = { disconnect: true };
    } else {
      data.deal = { connect: { id: dto.dealId } };
    }
  }

  // If items are provided, replace them all and recompute totals
  if (dto.items !== undefined) {
    if (dto.items.length === 0) {
      const err: any = new Error("Quote must have at least one item");
      err.statusCode = 400;
      throw err;
    }
    const totals = computeTotals(dto.items);
    data.subtotal = totals.subtotal;
    data.discountAmount = totals.discountAmount;
    data.taxAmount = totals.taxAmount;
    data.total = totals.total;

    await prisma.$transaction([
      prisma.quoteItem.deleteMany({ where: { quoteId } }),
      prisma.quoteItem.createMany({
        data: dto.items.map((it, idx) => {
          const { lineTotal } = computeLineTotal(it);
          return {
            quoteId,
            name: it.name.trim(),
            description: it.description?.trim() || null,
            quantity: it.quantity,
            unitPrice: it.unitPrice,
            discountPercent: it.discountPercent ?? 0,
            taxPercent: it.taxPercent ?? 0,
            lineTotal,
            position: it.position ?? idx,
          };
        }),
      }),
    ]);
  }

  return prisma.quote.update({
    where: { id: quoteId },
    data,
    include: quoteInclude,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// STATUS TRANSITIONS
// ─────────────────────────────────────────────────────────────────────────
export async function sendQuote(companyId: string, quoteId: string) {
  return updateQuote(companyId, quoteId, { status: "sent" });
}

export async function acceptQuote(companyId: string, quoteId: string) {
  const result = await updateQuote(companyId, quoteId, { status: "accepted" });
  // If linked to a deal, auto-advance stage
  if (result.dealId) {
    try {
      await prisma.deal.update({
        where: { id: result.dealId },
        data: { stage: "proposal_accepted" },
      });
    } catch {
      /* non-fatal */
    }
  }
  return result;
}

export async function rejectQuote(companyId: string, quoteId: string) {
  return updateQuote(companyId, quoteId, { status: "rejected" });
}

// ─────────────────────────────────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────────────────────────────────
export async function deleteQuote(companyId: string, quoteId: string) {
  const existing = await prisma.quote.findFirst({
    where: { id: quoteId, companyId },
    select: { id: true },
  });
  if (!existing) throw notFound("Quote");
  await prisma.quote.delete({ where: { id: quoteId } });
  return { deleted: true };
}

// ─────────────────────────────────────────────────────────────────────────
// STATS
// ─────────────────────────────────────────────────────────────────────────
export async function getQuoteStats(companyId: string) {
  const now = new Date();

  const [total, draft, sent, viewed, accepted, rejected, expired, acceptedValue, pendingValue] =
    await Promise.all([
      prisma.quote.count({ where: { companyId } }),
      prisma.quote.count({ where: { companyId, status: "draft" } }),
      prisma.quote.count({ where: { companyId, status: "sent" } }),
      prisma.quote.count({ where: { companyId, status: "viewed" } }),
      prisma.quote.count({ where: { companyId, status: "accepted" } }),
      prisma.quote.count({ where: { companyId, status: "rejected" } }),
      prisma.quote.count({
        where: {
          companyId,
          status: { in: ["sent", "viewed"] },
          validUntil: { lt: now },
        },
      }),
      prisma.quote.aggregate({
        where: { companyId, status: "accepted" },
        _sum: { total: true },
      }),
      prisma.quote.aggregate({
        where: { companyId, status: { in: ["sent", "viewed"] } },
        _sum: { total: true },
      }),
    ]);

  return {
    total,
    byStatus: { draft, sent, viewed, accepted, rejected, expired },
    acceptedValue: Number(acceptedValue._sum.total ?? 0),
    pendingValue: Number(pendingValue._sum.total ?? 0),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Shared include clause
// ─────────────────────────────────────────────────────────────────────────
const quoteInclude = {
  customer: {
    select: { id: true, fullName: true, companyName: true, email: true },
  },
  deal: { select: { id: true, title: true, stage: true } },
  createdBy: { select: { id: true, email: true, fullName: true } },
  items: { orderBy: { position: "asc" as const } },
} satisfies Prisma.QuoteInclude;
