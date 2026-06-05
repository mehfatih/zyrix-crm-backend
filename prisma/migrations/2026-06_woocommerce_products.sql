-- WooCommerce products bridge (post-Sprint-12 task)
-- Additive: surface a per-store product count in the sync banner, mirroring
-- totalCustomersImported / totalOrdersImported. The unified `products` table
-- and its partial-unique index (uq_products_company_source_ext) already exist
-- from Sprint 8, so the bridge needs no new product table.
ALTER TABLE "ecommerce_stores"
  ADD COLUMN IF NOT EXISTS "totalProductsImported" INTEGER NOT NULL DEFAULT 0;
