import { prisma } from "../config/database";
import { badRequest, notFound } from "../middleware/errorHandler";
import * as stockService from "./stock.service";

// ─────────────────────────────────────────────────────────────────────────
// DEAL LINE ITEMS (Sprint 8) — CPQ prerequisite
//
// `name` is a snapshot taken at add-time so the line survives later product
// edits/archival. Per-company `dealValueMode`:
//   manual    → deal.value is left to the user (default)
//   items_sum → deal.value is recomputed as the sum of line totals on every
//               item mutation.
// Selling does NOT auto-move stock — "Deduct stock" is an explicit action that
// writes `out` movements with refType='deal'.
// ─────────────────────────────────────────────────────────────────────────

export interface DealItemDto {
  productId?: string | null;
  name: string;
  qty?: number;
  unitPrice: number;
  discountPct?: number;
  taxRate?: number | null;
  position?: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Line total INCLUDING tax: qty × unit → discount → tax.
function computeTotal(
  qty: number,
  unitPrice: number,
  discountPct: number,
  taxRate: number | null
): number {
  const gross = qty * unitPrice;
  const afterDiscount = gross * (1 - (discountPct || 0) / 100);
  const tax = afterDiscount * ((taxRate || 0) / 100);
  return round2(afterDiscount + tax);
}

async function assertDeal(companyId: string, dealId: string) {
  const deal = await prisma.deal.findFirst({
    where: { id: dealId, companyId },
    select: { id: true },
  });
  if (!deal) throw notFound("Deal");
}

// Recompute deal.value from line items when the company uses items_sum mode.
async function recomputeDealValue(companyId: string, dealId: string) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { dealValueMode: true },
  });
  if (company?.dealValueMode !== "items_sum") return;
  const agg = await prisma.dealItem.aggregate({
    where: { dealId },
    _sum: { total: true },
  });
  const sum = Number(agg._sum.total ?? 0);
  await prisma.deal.update({ where: { id: dealId }, data: { value: sum } });
}

function totalsFor(
  items: Array<{
    qty: unknown;
    unitPrice: unknown;
    discountPct: unknown;
    taxRate: unknown;
    total: unknown;
  }>
) {
  let subtotal = 0;
  let tax = 0;
  let total = 0;
  for (const it of items) {
    const qty = Number(it.qty);
    const unitPrice = Number(it.unitPrice);
    const discountPct = Number(it.discountPct);
    const taxRate = it.taxRate == null ? 0 : Number(it.taxRate);
    const afterDiscount = qty * unitPrice * (1 - discountPct / 100);
    subtotal += afterDiscount;
    tax += afterDiscount * (taxRate / 100);
    total += Number(it.total);
  }
  return { subtotal: round2(subtotal), tax: round2(tax), total: round2(total) };
}

// ── LIST (+ totals footer) ─────────────────────────────────────────────────
export async function listItems(companyId: string, dealId: string) {
  await assertDeal(companyId, dealId);
  const items = await prisma.dealItem.findMany({
    where: { dealId },
    orderBy: { position: "asc" },
  });
  return { items, totals: totalsFor(items) };
}

// ── CREATE ─────────────────────────────────────────────────────────────────
export async function createItem(
  companyId: string,
  dealId: string,
  dto: DealItemDto
) {
  await assertDeal(companyId, dealId);

  // If a productId is supplied, make sure it belongs to this company.
  if (dto.productId) {
    const product = await prisma.product.findFirst({
      where: { id: dto.productId, companyId },
      select: { id: true },
    });
    if (!product) throw badRequest("Product not found in this company");
  }

  const qty = dto.qty ?? 1;
  const discountPct = dto.discountPct ?? 0;
  const taxRate = dto.taxRate ?? null;
  const total = computeTotal(qty, dto.unitPrice, discountPct, taxRate);

  const item = await prisma.dealItem.create({
    data: {
      companyId,
      dealId,
      productId: dto.productId ?? null,
      name: dto.name,
      qty,
      unitPrice: dto.unitPrice,
      discountPct,
      taxRate,
      total,
      position: dto.position ?? 0,
    },
  });
  await recomputeDealValue(companyId, dealId);
  return item;
}

// ── UPDATE ─────────────────────────────────────────────────────────────────
export async function updateItem(
  companyId: string,
  dealId: string,
  itemId: string,
  dto: Partial<DealItemDto>
) {
  await assertDeal(companyId, dealId);
  const existing = await prisma.dealItem.findFirst({
    where: { id: itemId, dealId, companyId },
  });
  if (!existing) throw notFound("Deal item");

  const qty = dto.qty ?? Number(existing.qty);
  const unitPrice = dto.unitPrice ?? Number(existing.unitPrice);
  const discountPct = dto.discountPct ?? Number(existing.discountPct);
  const taxRate =
    dto.taxRate !== undefined
      ? dto.taxRate
      : existing.taxRate == null
        ? null
        : Number(existing.taxRate);
  const total = computeTotal(qty, unitPrice, discountPct, taxRate);

  const item = await prisma.dealItem.update({
    where: { id: itemId },
    data: {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.productId !== undefined && { productId: dto.productId }),
      ...(dto.position !== undefined && { position: dto.position }),
      qty,
      unitPrice,
      discountPct,
      taxRate,
      total,
    },
  });
  await recomputeDealValue(companyId, dealId);
  return item;
}

// ── DELETE ─────────────────────────────────────────────────────────────────
export async function deleteItem(
  companyId: string,
  dealId: string,
  itemId: string
) {
  await assertDeal(companyId, dealId);
  const existing = await prisma.dealItem.findFirst({
    where: { id: itemId, dealId, companyId },
    select: { id: true },
  });
  if (!existing) throw notFound("Deal item");
  await prisma.dealItem.delete({ where: { id: itemId } });
  await recomputeDealValue(companyId, dealId);
  return { id: itemId, deleted: true };
}

// ── DEDUCT STOCK (explicit) ────────────────────────────────────────────────
// Writes an `out` movement (reason='sale', refType='deal') for every line item
// that references a product. Continues past per-item failures (e.g. would go
// negative without override) and reports the outcome of each.
export async function deductStock(
  companyId: string,
  dealId: string,
  userId: string | null,
  override = false
) {
  await assertDeal(companyId, dealId);
  const items = await prisma.dealItem.findMany({
    where: { dealId, companyId, NOT: { productId: null } },
  });

  const results: Array<{
    itemId: string;
    productId: string;
    ok: boolean;
    newQty?: number;
    error?: string;
  }> = [];

  for (const it of items) {
    if (!it.productId) continue;
    try {
      const r = await stockService.createMovement(companyId, it.productId, userId, {
        type: "out",
        qty: Number(it.qty),
        reason: "sale",
        refType: "deal",
        refId: dealId,
        override,
      });
      results.push({
        itemId: it.id,
        productId: it.productId,
        ok: true,
        newQty: r.newQty,
      });
    } catch (e) {
      results.push({
        itemId: it.id,
        productId: it.productId,
        ok: false,
        error: (e as Error).message,
      });
    }
  }
  return { results };
}
