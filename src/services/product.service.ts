import { prisma } from "../config/database";
import { badRequest, notFound } from "../middleware/errorHandler";

// ─────────────────────────────────────────────────────────────────────────
// PRODUCTS (Sprint 8) — unified catalog service
//
// Locally-created products (source='local') are fully editable by merchants.
// Synced products (source='shopify' etc.) are managed by the upstream
// platform: only local-only fields (cost, status) may change here, and they
// can NEVER be hard-deleted — archive only. Stock levels/thresholds live on
// stock_levels and are managed by the stock endpoints (Phase B).
// ─────────────────────────────────────────────────────────────────────────

export interface CreateProductDto {
  name: string;
  sku?: string | null;
  description?: string | null;
  price?: number;
  cost?: number | null;
  currency?: string;
  taxRate?: number | null;
  unit?: string | null;
  imageUrl?: string | null;
}

export interface UpdateProductDto {
  name?: string;
  sku?: string | null;
  description?: string | null;
  price?: number;
  cost?: number | null;
  currency?: string;
  taxRate?: number | null;
  unit?: string | null;
  imageUrl?: string | null;
  status?: "active" | "archived";
}

export interface ListProductsQuery {
  page?: number;
  limit?: number;
  search?: string;
  source?: string;
  status?: string;
  lowStock?: boolean;
}

// What the merchant may edit on a SYNCED product. Everything else is
// "managed by Shopify" and silently ignored to keep the upstream source of
// truth authoritative.
const SYNCED_EDITABLE = new Set(["cost", "status"]);

function isSynced(source: string): boolean {
  return source !== "local";
}

// ── CREATE (local only) ────────────────────────────────────────────────────
export async function createProduct(companyId: string, dto: CreateProductDto) {
  const product = await prisma.product.create({
    data: {
      companyId,
      source: "local",
      name: dto.name,
      sku: dto.sku ?? null,
      description: dto.description ?? null,
      price: dto.price ?? 0,
      cost: dto.cost ?? null,
      currency: dto.currency ?? "TRY",
      taxRate: dto.taxRate ?? null,
      unit: dto.unit ?? null,
      imageUrl: dto.imageUrl ?? null,
      // Seed a 'main' stock level at zero so the catalog badge is meaningful
      // immediately; movements (Phase B) adjust it from here.
      stockLevels: { create: { location: "main", qty: 0 } },
    },
    include: { stockLevels: true },
  });
  return product;
}

// ── LIST (raw SQL: catalog + 'main' stock level join + filters) ────────────
export async function listProducts(companyId: string, query: ListProductsQuery) {
  const page = query.page && query.page > 0 ? query.page : 1;
  const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 500) : 20;
  const offset = (page - 1) * limit;

  const conds: string[] = [`p."companyId" = $1`];
  const params: unknown[] = [companyId];

  if (query.status) {
    params.push(query.status);
    conds.push(`p.status = $${params.length}`);
  }
  if (query.source) {
    params.push(query.source);
    conds.push(`p.source = $${params.length}`);
  }
  if (query.search && query.search.trim()) {
    const idx = params.length + 1;
    params.push(`%${query.search.trim()}%`);
    conds.push(`(p.name ILIKE $${idx} OR p.sku ILIKE $${idx})`);
  }
  if (query.lowStock) {
    conds.push(
      `sl.qty IS NOT NULL AND sl."lowStockThreshold" IS NOT NULL AND sl.qty <= sl."lowStockThreshold"`
    );
  }
  const where = conds.join(" AND ");

  const rows = (await prisma.$queryRawUnsafe(
    `SELECT p."id", p."companyId", p."sku", p."name", p."description",
            p."price"::text   AS "price",
            p."cost"::text    AS "cost",
            p."currency", p."taxRate"::text AS "taxRate", p."unit", p."imageUrl",
            p."source", p."externalId", p."status", p."createdAt", p."updatedAt",
            sl."qty"::text                AS "stockQty",
            sl."lowStockThreshold"::text  AS "lowStockThreshold"
       FROM products p
       LEFT JOIN stock_levels sl ON sl."productId" = p."id" AND sl."location" = 'main'
      WHERE ${where}
      ORDER BY p."createdAt" DESC
      LIMIT ${limit} OFFSET ${offset}`,
    ...params
  )) as Array<Record<string, unknown>>;

  const totalRow = (await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n
       FROM products p
       LEFT JOIN stock_levels sl ON sl."productId" = p."id" AND sl."location" = 'main'
      WHERE ${where}`,
    ...params
  )) as Array<{ n: number }>;

  const products = rows.map((r) => ({
    id: r.id,
    companyId: r.companyId,
    sku: r.sku,
    name: r.name,
    description: r.description,
    price: r.price == null ? 0 : Number(r.price),
    cost: r.cost == null ? null : Number(r.cost),
    currency: r.currency,
    taxRate: r.taxRate == null ? null : Number(r.taxRate),
    unit: r.unit,
    imageUrl: r.imageUrl,
    source: r.source,
    externalId: r.externalId,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    stockQty: r.stockQty == null ? null : Number(r.stockQty),
    lowStockThreshold:
      r.lowStockThreshold == null ? null : Number(r.lowStockThreshold),
  }));

  const total = totalRow[0]?.n ?? 0;
  return {
    products,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

// ── GET ONE ────────────────────────────────────────────────────────────────
export async function getProductById(companyId: string, id: string) {
  const product = await prisma.product.findFirst({
    where: { id, companyId },
    include: { stockLevels: true },
  });
  if (!product) throw notFound("Product");
  return product;
}

// ── UPDATE ─────────────────────────────────────────────────────────────────
export async function updateProduct(
  companyId: string,
  id: string,
  dto: UpdateProductDto
) {
  const existing = await prisma.product.findFirst({ where: { id, companyId } });
  if (!existing) throw notFound("Product");

  // For synced products, drop any field the merchant isn't allowed to touch
  // (managed by the upstream platform). Local products: everything goes.
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(dto)) {
    if (value === undefined) continue;
    if (isSynced(existing.source) && !SYNCED_EDITABLE.has(key)) continue;
    data[key] = value;
  }
  if (Object.keys(data).length === 0) {
    // Nothing the caller is permitted to change — return as-is.
    return getProductById(companyId, id);
  }

  await prisma.product.update({ where: { id }, data });
  return getProductById(companyId, id);
}

// ── ARCHIVE / UNARCHIVE (status toggle; safe for synced rows) ──────────────
export async function setProductStatus(
  companyId: string,
  id: string,
  status: "active" | "archived"
) {
  const existing = await prisma.product.findFirst({ where: { id, companyId } });
  if (!existing) throw notFound("Product");
  await prisma.product.update({ where: { id }, data: { status } });
  return getProductById(companyId, id);
}

// ── DELETE (hard-delete LOCAL only; synced rows must be archived) ──────────
export async function deleteProduct(companyId: string, id: string) {
  const existing = await prisma.product.findFirst({ where: { id, companyId } });
  if (!existing) throw notFound("Product");
  if (isSynced(existing.source)) {
    throw badRequest(
      "Synced products cannot be deleted — archive them instead."
    );
  }
  // The Sprint 8 tables carry no DB-level foreign keys, so Prisma's
  // onDelete: Cascade does not fire. Clean up children explicitly and detach
  // deal line items (their `name` snapshot keeps the history readable).
  await prisma.$transaction([
    prisma.stockMovement.deleteMany({ where: { productId: id } }),
    prisma.stockLevel.deleteMany({ where: { productId: id } }),
    prisma.dealItem.updateMany({
      where: { productId: id },
      data: { productId: null },
    }),
    prisma.product.delete({ where: { id } }),
  ]);
  return { id, deleted: true };
}
