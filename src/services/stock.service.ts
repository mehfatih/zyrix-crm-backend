import { prisma } from "../config/database";
import { badRequest, notFound } from "../middleware/errorHandler";

// ─────────────────────────────────────────────────────────────────────────
// STOCK (Sprint 8) — movements + levels
//
// A movement and its level update are applied ATOMICALLY in one interactive
// transaction. The 'main' (or given) stock_levels row is created on demand
// and locked FOR UPDATE so concurrent movements serialize correctly (no lost
// updates). stock_movements.qty stores the SIGNED delta applied, so the
// ledger always sums to the current level:
//   in     → +|qty|
//   out    → -|qty|   (blocked if it would drive the level negative, unless
//                       `override` is set)
//   adjust → signed qty as given (manual correction; e.g. -2 shrinkage)
// ─────────────────────────────────────────────────────────────────────────

export type MovementType = "in" | "out" | "adjust";

export interface CreateMovementDto {
  type: MovementType;
  qty: number;
  location?: string;
  reason?: string | null;
  refType?: string | null;
  refId?: string | null;
  override?: boolean; // allow the resulting level to go negative
}

export interface MovementResult {
  id: string;
  productId: string;
  location: string;
  type: MovementType;
  qty: number; // signed delta applied
  newQty: number; // resulting on-hand level
  lowStockThreshold: number | null;
  lowStock: boolean; // newQty <= threshold (threshold set)
}

function normLocation(location?: string): string {
  return (location || "main").trim() || "main";
}

async function assertProduct(companyId: string, productId: string) {
  const product = await prisma.product.findFirst({
    where: { id: productId, companyId },
    select: { id: true, name: true, sku: true },
  });
  if (!product) throw notFound("Product");
  return product;
}

// ── CREATE MOVEMENT (atomic) ───────────────────────────────────────────────
export async function createMovement(
  companyId: string,
  productId: string,
  userId: string | null,
  dto: CreateMovementDto
): Promise<MovementResult> {
  await assertProduct(companyId, productId);

  const location = normLocation(dto.location);
  const raw = Number(dto.qty);
  if (!Number.isFinite(raw) || raw === 0) {
    throw badRequest("qty must be a non-zero number");
  }
  const mag = Math.abs(raw);
  const delta =
    dto.type === "in" ? mag : dto.type === "out" ? -mag : raw; // adjust = signed

  return prisma.$transaction(async (tx) => {
    // Ensure the level row exists so the subsequent FOR UPDATE actually locks
    // it (serializing concurrent movements on the same product/location).
    await tx.$executeRawUnsafe(
      `INSERT INTO stock_levels (id, "productId", location, qty, "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, 0, now())
       ON CONFLICT ("productId", location) DO NOTHING`,
      productId,
      location
    );

    const rows = (await tx.$queryRawUnsafe(
      `SELECT qty::text AS qty, "lowStockThreshold"::text AS threshold
         FROM stock_levels
        WHERE "productId" = $1 AND location = $2
        FOR UPDATE`,
      productId,
      location
    )) as Array<{ qty: string; threshold: string | null }>;

    const oldQty = rows[0] ? Number(rows[0].qty) : 0;
    const threshold =
      rows[0]?.threshold != null ? Number(rows[0].threshold) : null;
    const newQty = oldQty + delta;

    if (newQty < 0 && !dto.override) {
      throw badRequest(
        `Insufficient stock: ${oldQty} on hand at '${location}'. ` +
          `This movement would leave ${newQty}. Pass override=true to allow negative stock.`
      );
    }

    await tx.$executeRawUnsafe(
      `UPDATE stock_levels SET qty = $1, "updatedAt" = now()
        WHERE "productId" = $2 AND location = $3`,
      newQty,
      productId,
      location
    );

    const mv = (await tx.$queryRawUnsafe(
      `INSERT INTO stock_movements
         (id, "companyId", "productId", location, type, qty, reason, "refType", "refId", "userId", "createdAt")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       RETURNING id`,
      companyId,
      productId,
      location,
      dto.type,
      delta,
      dto.reason ?? null,
      dto.refType ?? null,
      dto.refId ?? null,
      userId ?? null
    )) as Array<{ id: string }>;

    return {
      id: mv[0].id,
      productId,
      location,
      type: dto.type,
      qty: delta,
      newQty,
      lowStockThreshold: threshold,
      lowStock: threshold != null && newQty <= threshold,
    };
  });
}

// ── MOVEMENT HISTORY ───────────────────────────────────────────────────────
export async function listMovements(
  companyId: string,
  productId: string,
  opts: { limit?: number; location?: string } = {}
) {
  await assertProduct(companyId, productId);
  const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 200) : 50;

  const conds = [`"companyId" = $1`, `"productId" = $2`];
  const params: unknown[] = [companyId, productId];
  if (opts.location) {
    params.push(opts.location);
    conds.push(`location = $${params.length}`);
  }

  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id, location, type, qty::text AS qty, reason, "refType", "refId",
            "userId", "createdAt"
       FROM stock_movements
      WHERE ${conds.join(" AND ")}
      ORDER BY "createdAt" DESC
      LIMIT ${limit}`,
    ...params
  )) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: r.id,
    location: r.location,
    type: r.type,
    qty: r.qty == null ? 0 : Number(r.qty),
    reason: r.reason,
    refType: r.refType,
    refId: r.refId,
    userId: r.userId,
    createdAt: r.createdAt,
  }));
}

// ── SET LOW-STOCK THRESHOLD (per product/location) ─────────────────────────
export async function setThreshold(
  companyId: string,
  productId: string,
  threshold: number | null,
  location?: string
) {
  await assertProduct(companyId, productId);
  const loc = normLocation(location);

  await prisma.$executeRawUnsafe(
    `INSERT INTO stock_levels (id, "productId", location, qty, "lowStockThreshold", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, 0, $3, now())
     ON CONFLICT ("productId", location)
     DO UPDATE SET "lowStockThreshold" = EXCLUDED."lowStockThreshold", "updatedAt" = now()`,
    productId,
    loc,
    threshold
  );

  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id, "productId", location, qty::text AS qty,
            "lowStockThreshold"::text AS "lowStockThreshold", "updatedAt"
       FROM stock_levels
      WHERE "productId" = $1 AND location = $2`,
    productId,
    loc
  )) as Array<Record<string, unknown>>;

  const r = rows[0];
  return r
    ? {
        id: r.id,
        productId: r.productId,
        location: r.location,
        qty: r.qty == null ? 0 : Number(r.qty),
        lowStockThreshold:
          r.lowStockThreshold == null ? null : Number(r.lowStockThreshold),
        updatedAt: r.updatedAt,
      }
    : null;
}
