// ============================================================================
// CPQ CATALOG SERVICE — Sprint 9
// ----------------------------------------------------------------------------
// CRUD + resolution for price books (+ entries), discount rules, and bundles.
// All tenant-scoped by companyId. Resolution helpers (price-book auto-pick by
// segment, per-product price lookup, bundle→line expansion) are reused by the
// quote builder, the calc path, and the AI suggestion.
// ============================================================================

import { prisma } from "../config/database";
import { badRequest, notFound } from "../middleware/errorHandler";
import type { CpqLine } from "./cpq-calc.service";

// ── Types ───────────────────────────────────────────────────────────────────
export interface SegmentRules {
  tags?: string[];
  countries?: string[];
}

export interface PriceBookDto {
  name: string;
  currency?: string;
  isDefault?: boolean;
  segmentRules?: SegmentRules | null;
}

export interface PriceBookEntryDto {
  productId: string;
  price: number;
}

export interface DiscountRuleDto {
  scope?: "role" | "user";
  scopeValue: string;
  maxPct: number;
  approvalAbovePct?: number | null;
}

export interface BundleItem {
  productId: string;
  qty: number;
}

export interface BundleDto {
  name: string;
  items: BundleItem[];
  bundlePrice: number;
  status?: "active" | "archived";
}

function parseSegment(raw: string | null): SegmentRules | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? (o as SegmentRules) : null;
  } catch {
    return null;
  }
}

// ── PRICE BOOKS ──────────────────────────────────────────────────────────────
export async function listPriceBooks(companyId: string) {
  const books = await prisma.priceBook.findMany({
    where: { companyId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
  // entry counts for the settings grid
  const counts = await prisma.priceBookEntry.groupBy({
    by: ["priceBookId"],
    where: { priceBookId: { in: books.map((b) => b.id) } },
    _count: { _all: true },
  });
  const countMap = new Map(counts.map((c) => [c.priceBookId, c._count._all]));
  return books.map((b) => ({
    ...b,
    segmentRules: parseSegment(b.segmentRules),
    entryCount: countMap.get(b.id) ?? 0,
  }));
}

export async function getPriceBook(companyId: string, id: string) {
  const book = await prisma.priceBook.findFirst({ where: { id, companyId } });
  if (!book) throw notFound("Price book");
  const entries = await prisma.priceBookEntry.findMany({
    where: { priceBookId: id },
  });
  return { ...book, segmentRules: parseSegment(book.segmentRules), entries };
}

export async function createPriceBook(companyId: string, dto: PriceBookDto) {
  return prisma.$transaction(async (tx) => {
    if (dto.isDefault) {
      await tx.priceBook.updateMany({
        where: { companyId, isDefault: true },
        data: { isDefault: false },
      });
    }
    return tx.priceBook.create({
      data: {
        companyId,
        name: dto.name.trim(),
        currency: dto.currency ?? "TRY",
        isDefault: dto.isDefault ?? false,
        segmentRules: dto.segmentRules
          ? JSON.stringify(dto.segmentRules)
          : null,
      },
    });
  });
}

export async function updatePriceBook(
  companyId: string,
  id: string,
  dto: Partial<PriceBookDto>
) {
  const existing = await prisma.priceBook.findFirst({ where: { id, companyId } });
  if (!existing) throw notFound("Price book");
  return prisma.$transaction(async (tx) => {
    if (dto.isDefault) {
      await tx.priceBook.updateMany({
        where: { companyId, isDefault: true, NOT: { id } },
        data: { isDefault: false },
      });
    }
    return tx.priceBook.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.currency !== undefined && { currency: dto.currency }),
        ...(dto.isDefault !== undefined && { isDefault: dto.isDefault }),
        ...(dto.segmentRules !== undefined && {
          segmentRules: dto.segmentRules
            ? JSON.stringify(dto.segmentRules)
            : null,
        }),
      },
    });
  });
}

export async function deletePriceBook(companyId: string, id: string) {
  const existing = await prisma.priceBook.findFirst({
    where: { id, companyId },
    select: { id: true },
  });
  if (!existing) throw notFound("Price book");
  await prisma.$transaction([
    prisma.priceBookEntry.deleteMany({ where: { priceBookId: id } }),
    prisma.priceBook.delete({ where: { id } }),
  ]);
  return { id, deleted: true };
}

// ── PRICE BOOK ENTRIES ───────────────────────────────────────────────────────
async function assertPriceBook(companyId: string, priceBookId: string) {
  const b = await prisma.priceBook.findFirst({
    where: { id: priceBookId, companyId },
    select: { id: true },
  });
  if (!b) throw notFound("Price book");
}

// Upsert one (book, product) price.
export async function setEntry(
  companyId: string,
  priceBookId: string,
  dto: PriceBookEntryDto
) {
  await assertPriceBook(companyId, priceBookId);
  const product = await prisma.product.findFirst({
    where: { id: dto.productId, companyId },
    select: { id: true },
  });
  if (!product) throw badRequest("Product not found in this company");
  return prisma.priceBookEntry.upsert({
    where: {
      priceBookId_productId: { priceBookId, productId: dto.productId },
    },
    create: { priceBookId, productId: dto.productId, price: dto.price },
    update: { price: dto.price },
  });
}

export async function deleteEntry(
  companyId: string,
  priceBookId: string,
  productId: string
) {
  await assertPriceBook(companyId, priceBookId);
  await prisma.priceBookEntry.deleteMany({ where: { priceBookId, productId } });
  return { priceBookId, productId, deleted: true };
}

// ── DISCOUNT RULES ─────────────────────────────────────────────────────────
export async function listDiscountRules(companyId: string) {
  return prisma.discountRule.findMany({ where: { companyId }, orderBy: { scopeValue: "asc" } });
}

export async function createDiscountRule(companyId: string, dto: DiscountRuleDto) {
  if (
    dto.approvalAbovePct != null &&
    Number(dto.approvalAbovePct) < Number(dto.maxPct)
  ) {
    throw badRequest("approvalAbovePct must be ≥ maxPct");
  }
  return prisma.discountRule.create({
    data: {
      companyId,
      scope: dto.scope ?? "role",
      scopeValue: dto.scopeValue.trim(),
      maxPct: dto.maxPct,
      approvalAbovePct: dto.approvalAbovePct ?? null,
    },
  });
}

export async function updateDiscountRule(
  companyId: string,
  id: string,
  dto: Partial<DiscountRuleDto>
) {
  const existing = await prisma.discountRule.findFirst({ where: { id, companyId } });
  if (!existing) throw notFound("Discount rule");
  const maxPct = dto.maxPct ?? Number(existing.maxPct);
  const approvalAbovePct =
    dto.approvalAbovePct !== undefined
      ? dto.approvalAbovePct
      : existing.approvalAbovePct == null
        ? null
        : Number(existing.approvalAbovePct);
  if (approvalAbovePct != null && Number(approvalAbovePct) < Number(maxPct)) {
    throw badRequest("approvalAbovePct must be ≥ maxPct");
  }
  return prisma.discountRule.update({
    where: { id },
    data: {
      ...(dto.scope !== undefined && { scope: dto.scope }),
      ...(dto.scopeValue !== undefined && { scopeValue: dto.scopeValue.trim() }),
      ...(dto.maxPct !== undefined && { maxPct: dto.maxPct }),
      ...(dto.approvalAbovePct !== undefined && {
        approvalAbovePct: dto.approvalAbovePct,
      }),
    },
  });
}

export async function deleteDiscountRule(companyId: string, id: string) {
  const existing = await prisma.discountRule.findFirst({
    where: { id, companyId },
    select: { id: true },
  });
  if (!existing) throw notFound("Discount rule");
  await prisma.discountRule.delete({ where: { id } });
  return { id, deleted: true };
}

// ── BUNDLES ──────────────────────────────────────────────────────────────────
function parseBundleItems(raw: string): BundleItem[] {
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? (a as BundleItem[]) : [];
  } catch {
    return [];
  }
}

export async function listBundles(companyId: string, includeArchived = false) {
  const bundles = await prisma.bundle.findMany({
    where: { companyId, ...(includeArchived ? {} : { status: "active" }) },
    orderBy: { name: "asc" },
  });
  return bundles.map((b) => ({ ...b, items: parseBundleItems(b.items) }));
}

export async function getBundle(companyId: string, id: string) {
  const b = await prisma.bundle.findFirst({ where: { id, companyId } });
  if (!b) throw notFound("Bundle");
  return { ...b, items: parseBundleItems(b.items) };
}

async function assertBundleProducts(companyId: string, items: BundleItem[]) {
  if (!items.length) throw badRequest("Bundle must have at least one item");
  const ids = [...new Set(items.map((i) => i.productId))];
  const found = await prisma.product.count({
    where: { id: { in: ids }, companyId },
  });
  if (found !== ids.length) throw badRequest("One or more products not found in this company");
}

export async function createBundle(companyId: string, dto: BundleDto) {
  await assertBundleProducts(companyId, dto.items);
  const b = await prisma.bundle.create({
    data: {
      companyId,
      name: dto.name.trim(),
      items: JSON.stringify(dto.items),
      bundlePrice: dto.bundlePrice,
      status: dto.status ?? "active",
    },
  });
  return { ...b, items: parseBundleItems(b.items) };
}

export async function updateBundle(
  companyId: string,
  id: string,
  dto: Partial<BundleDto>
) {
  const existing = await prisma.bundle.findFirst({ where: { id, companyId } });
  if (!existing) throw notFound("Bundle");
  if (dto.items) await assertBundleProducts(companyId, dto.items);
  const b = await prisma.bundle.update({
    where: { id },
    data: {
      ...(dto.name !== undefined && { name: dto.name.trim() }),
      ...(dto.items !== undefined && { items: JSON.stringify(dto.items) }),
      ...(dto.bundlePrice !== undefined && { bundlePrice: dto.bundlePrice }),
      ...(dto.status !== undefined && { status: dto.status }),
    },
  });
  return { ...b, items: parseBundleItems(b.items) };
}

export async function deleteBundle(companyId: string, id: string) {
  const existing = await prisma.bundle.findFirst({
    where: { id, companyId },
    select: { id: true },
  });
  if (!existing) throw notFound("Bundle");
  await prisma.bundle.delete({ where: { id } });
  return { id, deleted: true };
}

// ── RESOLUTION HELPERS (reused by the builder / calc / AI) ───────────────────

// Auto-pick the price book for a customer: first book whose segmentRules match
// the customer's country or tags, else the company default, else null.
export async function resolvePriceBookForCustomer(
  companyId: string,
  customerId: string
): Promise<{ id: string; currency: string } | null> {
  const [books, customer] = await Promise.all([
    prisma.priceBook.findMany({
      where: { companyId },
      orderBy: [{ createdAt: "asc" }],
    }),
    prisma.customer.findFirst({
      where: { id: customerId, companyId },
      select: { country: true, tags: { select: { tag: { select: { name: true } } } } },
    }),
  ]);
  if (!books.length) return null;

  const country = customer?.country ?? null;
  const tagNames = new Set(
    (customer?.tags ?? []).map((t) => t.tag.name.toLowerCase())
  );

  for (const b of books) {
    const rules = parseSegment(b.segmentRules);
    if (!rules) continue;
    const countryMatch =
      !!rules.countries?.length &&
      country != null &&
      rules.countries.map((c) => c.toUpperCase()).includes(country.toUpperCase());
    const tagMatch =
      !!rules.tags?.length &&
      rules.tags.some((t) => tagNames.has(t.toLowerCase()));
    if (countryMatch || tagMatch) {
      return { id: b.id, currency: b.currency };
    }
  }

  const def = books.find((b) => b.isDefault);
  return def ? { id: def.id, currency: def.currency } : null;
}

// Map of productId → price for a price book (empty if book has no entries).
export async function getPriceBookEntryMap(
  priceBookId: string
): Promise<Map<string, number>> {
  const entries = await prisma.priceBookEntry.findMany({ where: { priceBookId } });
  return new Map(entries.map((e) => [e.productId, Number(e.price)]));
}

// Expand a bundle to a single grouped quote line at its fixed bundle price.
// `taxPct` lets the builder pass a representative rate (default 0).
export function expandBundleToLine(
  bundle: { name: string; bundlePrice: number | string },
  qty = 1,
  taxPct = 0
): CpqLine & { name: string } {
  return {
    name: bundle.name,
    quantity: qty,
    unitPrice: Number(bundle.bundlePrice),
    discountPct: 0,
    taxPct,
  };
}
