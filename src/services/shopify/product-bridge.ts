import { prisma } from "../../config/database";
import type { ShopifyProductInput } from "./sync";

// ============================================================================
// SHOPIFY → UNIFIED CATALOG BRIDGE (Sprint 8)
// ----------------------------------------------------------------------------
// ADDITIVE hook. The existing shopify_products table + its sync/reconciliation
// remain byte-for-byte intact for their current consumers. On top of that, we
// mirror each synced product into the unified `products` table as
// source='shopify' so it shows in the catalog alongside local products.
//
// Both helpers are best-effort: callers invoke them with .catch() so a bridge
// failure NEVER breaks the primary shopify_products sync.
//
// Merchant-local fields (cost, currency, taxRate, unit, description, and the
// stock threshold) are intentionally NOT overwritten on update — only the
// Shopify-owned fields (name, sku, price, image, status, on-hand qty) are.
// ============================================================================

function mapStatus(s: string | null): "active" | "archived" {
  // Shopify status is active | archived | draft. Only 'active' is visible.
  return s === "active" ? "active" : "archived";
}

/** Upsert a synced product into `products` (source='shopify') + mirror its
 *  on-hand quantity into the 'main' stock level. */
export async function bridgeUpsertProduct(
  p: ShopifyProductInput
): Promise<void> {
  const name = (p.title && p.title.trim()) || "(untitled)";
  const status = mapStatus(p.status);

  const rows = (await prisma.$queryRawUnsafe(
    `INSERT INTO products
       (id, "companyId", source, "externalId", name, sku, price, "imageUrl", status, "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, 'shopify', $2, $3, $4, $5, $6, $7, now(), now())
     ON CONFLICT ("companyId", source, "externalId") WHERE "externalId" IS NOT NULL
     DO UPDATE SET
       name = EXCLUDED.name,
       sku = EXCLUDED.sku,
       price = EXCLUDED.price,
       "imageUrl" = EXCLUDED."imageUrl",
       status = EXCLUDED.status,
       "updatedAt" = now()
     RETURNING id`,
    p.companyId,
    p.externalId,
    name,
    p.sku,
    p.price ?? 0,
    p.imageUrl,
    status
  )) as Array<{ id: string }>;

  const productId = rows[0]?.id;
  if (productId && p.inventoryQuantity != null) {
    // Shopify owns the count for synced products — set the level directly (no
    // movement ledger entry). Threshold is left untouched (merchant-managed).
    await prisma.$executeRawUnsafe(
      `INSERT INTO stock_levels (id, "productId", location, qty, "updatedAt")
       VALUES (gen_random_uuid(), $1, 'main', $2, now())
       ON CONFLICT ("productId", location)
       DO UPDATE SET qty = EXCLUDED.qty, "updatedAt" = now()`,
      productId,
      p.inventoryQuantity
    );
  }
}

/** On products/delete, archive the catalog row (never hard-delete — keeps deal
 *  line-item history intact). */
export async function bridgeArchiveProduct(
  companyId: string,
  externalId: string
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE products SET status = 'archived', "updatedAt" = now()
      WHERE "companyId" = $1 AND source = 'shopify' AND "externalId" = $2`,
    companyId,
    externalId
  );
}
