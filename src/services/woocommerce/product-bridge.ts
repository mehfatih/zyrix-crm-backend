import { prisma } from "../../config/database";

// ============================================================================
// WOOCOMMERCE → UNIFIED CATALOG BRIDGE (post-Sprint-12 task)
// ----------------------------------------------------------------------------
// Mirrors the Shopify bridge (src/services/shopify/product-bridge.ts) but for
// WooCommerce. Unlike Shopify there is NO raw `woocommerce_products` table —
// the poll sync writes WC products straight into the unified `products` table
// as source='woocommerce', reusing the partial-unique index
// (uq_products_company_source_ext) that Sprint 8 created.
//
// Both helpers are best-effort: the caller invokes them so a bridge failure
// never breaks the primary customer/order import. Merchant-local fields
// (cost, taxRate, unit, description, stock threshold) are intentionally NOT
// overwritten on update — only the WooCommerce-owned fields (name, sku, price,
// image, status, on-hand qty) are.
// ============================================================================

export interface WooProductInput {
  companyId: string;
  externalId: string;
  name: string | null;
  sku: string | null;
  price: number | null;
  imageUrl: string | null;
  // WooCommerce status: publish | draft | pending | private. Only 'publish'
  // is a live, customer-visible product.
  status: string | null;
  // null when the product doesn't manage stock (manage_stock=false) — we then
  // leave the stock level untouched, same as Shopify's null inventory.
  stockQuantity: number | null;
}

function mapStatus(s: string | null): "active" | "archived" {
  return s === "publish" ? "active" : "archived";
}

/** Upsert a synced WC product into `products` (source='woocommerce') + mirror
 *  its on-hand quantity into the 'main' stock level. `currency` is the store's
 *  currency — when known it is stamped on the row (synced currency is
 *  store-owned / read-only locally); when not, the products table default
 *  applies on insert and the existing value is left untouched. */
export async function bridgeUpsertWooProduct(
  p: WooProductInput,
  currency?: string | null
): Promise<void> {
  const name = (p.name && p.name.trim()) || "(untitled)";
  const status = mapStatus(p.status);
  const cur =
    typeof currency === "string" && currency.trim()
      ? currency.trim().toUpperCase()
      : null;

  // Currency is included only when known, so a blank never overrides the
  // NOT NULL DEFAULT on insert nor clobbers a good value on update.
  const params: unknown[] = [
    p.companyId,
    p.externalId,
    name,
    p.sku,
    p.price ?? 0,
    p.imageUrl,
    status,
  ];
  if (cur) params.push(cur);
  const curCol = cur ? ", currency" : "";
  const curVal = cur ? `, $${params.length}` : "";
  const curUpd = cur ? ", currency = EXCLUDED.currency" : "";

  const rows = (await prisma.$queryRawUnsafe(
    `INSERT INTO products
       (id, "companyId", source, "externalId", name, sku, price, "imageUrl", status${curCol}, "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, 'woocommerce', $2, $3, $4, $5, $6, $7${curVal}, now(), now())
     ON CONFLICT ("companyId", source, "externalId") WHERE "externalId" IS NOT NULL
     DO UPDATE SET
       name = EXCLUDED.name,
       sku = EXCLUDED.sku,
       price = EXCLUDED.price,
       "imageUrl" = EXCLUDED."imageUrl",
       status = EXCLUDED.status${curUpd},
       "updatedAt" = now()
     RETURNING id`,
    ...params
  )) as Array<{ id: string }>;

  const productId = rows[0]?.id;
  if (productId && p.stockQuantity != null) {
    // WooCommerce owns the count for synced products — set the level directly
    // (no movement ledger entry). Threshold is left untouched (merchant-managed).
    await prisma.$executeRawUnsafe(
      `INSERT INTO stock_levels (id, "productId", location, qty, "updatedAt")
       VALUES (gen_random_uuid(), $1, 'main', $2, now())
       ON CONFLICT ("productId", location)
       DO UPDATE SET qty = EXCLUDED.qty, "updatedAt" = now()`,
      productId,
      p.stockQuantity
    );
  }
}

/** Archive every source='woocommerce' catalog row for this company whose
 *  externalId was NOT seen in the latest full sync (i.e. removed upstream).
 *  Never hard-deletes — keeps deal line-item history intact. The caller MUST
 *  only invoke this after a COMPLETE pull (didn't hit the page cap), otherwise
 *  products beyond the cap would be wrongly archived. Returns rows archived. */
export async function archiveMissingWooProducts(
  companyId: string,
  seenExternalIds: string[]
): Promise<number> {
  if (seenExternalIds.length === 0) {
    // A completed sync that returned zero products means the store has none —
    // archive any previously-synced woo products that now linger as active.
    const res = (await prisma.$executeRawUnsafe(
      `UPDATE products SET status = 'archived', "updatedAt" = now()
        WHERE "companyId" = $1 AND source = 'woocommerce' AND status <> 'archived'`,
      companyId
    )) as unknown as number;
    return Number(res) || 0;
  }
  const res = (await prisma.$executeRawUnsafe(
    `UPDATE products SET status = 'archived', "updatedAt" = now()
      WHERE "companyId" = $1 AND source = 'woocommerce'
        AND status <> 'archived'
        AND "externalId" <> ALL($2::text[])`,
    companyId,
    seenExternalIds
  )) as unknown as number;
  return Number(res) || 0;
}
