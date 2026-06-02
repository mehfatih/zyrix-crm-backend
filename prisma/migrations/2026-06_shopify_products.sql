-- ============================================================================
-- ZYRIX CRM — Shopify product catalog import
-- Run in Railway → Data tab → Query (idempotent — IF NOT EXISTS).
-- ----------------------------------------------------------------------------
-- Adds a home for imported Shopify products. ADDITIVE; safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "shopify_products" (
  "id"                TEXT PRIMARY KEY NOT NULL,
  "companyId"         TEXT NOT NULL,
  "connectionId"      TEXT NOT NULL,
  "externalId"        TEXT NOT NULL,            -- Shopify product id
  "title"             TEXT,
  "handle"            TEXT,
  "vendor"            TEXT,
  "productType"       TEXT,
  "status"            TEXT,                      -- active | draft | archived
  "variantsCount"     INTEGER NOT NULL DEFAULT 0,
  "sku"               TEXT,                      -- first variant sku
  "price"             DECIMAL(12,2),             -- first variant price
  "inventoryQuantity" INTEGER,                   -- summed across variants
  "imageUrl"          TEXT,
  "createdAt"         TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"         TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "shopify_products_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE,
  CONSTRAINT "shopify_products_connectionId_fkey"
    FOREIGN KEY ("connectionId") REFERENCES "shopify_connections"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "shopify_products_companyId_externalId_key"
  ON "shopify_products"("companyId", "externalId");
CREATE INDEX IF NOT EXISTS "shopify_products_companyId_idx"
  ON "shopify_products"("companyId");
CREATE INDEX IF NOT EXISTS "shopify_products_connectionId_idx"
  ON "shopify_products"("connectionId");

-- Verify:
--   SELECT to_regclass('public.shopify_products');  -- non-null = exists
