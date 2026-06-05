-- Sprint 8 — Products & Inventory
-- ADDITIVE ONLY. Safe to re-run (IF NOT EXISTS everywhere).
-- Apply in Railway → Data → SQL console (batch), and locally via
--   npx prisma db execute --file prisma/migrations/2026-06_sprint8_products.sql --schema prisma/schema.prisma
-- then `npx prisma generate`. Do NOT run prisma migrate/db push.

-- ── Unified product catalog ────────────────────────────────────────────────
-- Holds locally-created products AND e-commerce-synced products (Shopify
-- today; Salla/Zid later) in ONE table. `source` + `externalId` identify the
-- origin; `source='local'` rows are merchant-authored. The existing
-- shopify_products table is left byte-for-byte intact — a sync bridge mirrors
-- rows into this table (source='shopify') additively.
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  sku TEXT,
  name TEXT NOT NULL,
  description TEXT,
  price NUMERIC(14,2) NOT NULL DEFAULT 0,
  cost NUMERIC(14,2),
  currency TEXT NOT NULL DEFAULT 'TRY',
  "taxRate" NUMERIC(5,2),
  unit TEXT,                                   -- piece | kg | hour | ...
  "imageUrl" TEXT,
  source TEXT NOT NULL DEFAULT 'local',        -- local | shopify | salla | zid | ...
  "externalId" TEXT,
  status TEXT NOT NULL DEFAULT 'active',        -- active | archived
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Partial unique: one product per (company, source, externalId) for synced
-- rows; local rows (externalId IS NULL) are unconstrained. The Shopify bridge
-- upsert targets this index: ON CONFLICT ("companyId", source, "externalId").
CREATE UNIQUE INDEX IF NOT EXISTS uq_products_company_source_ext ON products("companyId", source, "externalId") WHERE "externalId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_company_status ON products("companyId", status);

-- ── Per-product, per-location stock level (current quantity on hand) ────────
CREATE TABLE IF NOT EXISTS stock_levels (
  id TEXT PRIMARY KEY,
  "productId" TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT 'main',
  qty NUMERIC(14,3) NOT NULL DEFAULT 0,
  "lowStockThreshold" NUMERIC(14,3),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE("productId", location)
);

-- ── Immutable stock movement ledger (in / out / adjust) ────────────────────
CREATE TABLE IF NOT EXISTS stock_movements (
  id TEXT PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT 'main',
  type TEXT NOT NULL,                          -- in | out | adjust
  qty NUMERIC(14,3) NOT NULL,
  reason TEXT,                                 -- purchase | sale | return | correction | manual
  "refType" TEXT, "refId" TEXT,                -- e.g. deal / quote linkage
  "userId" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements("productId", "createdAt");

-- ── Deal line items (CPQ prerequisite) ─────────────────────────────────────
-- `name` is a snapshot so the line survives later product edits/archival.
CREATE TABLE IF NOT EXISTS deal_items (
  id TEXT PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  "dealId" TEXT NOT NULL,
  "productId" TEXT,
  name TEXT NOT NULL,                          -- snapshot (survives product edits)
  qty NUMERIC(14,3) NOT NULL DEFAULT 1,
  "unitPrice" NUMERIC(14,2) NOT NULL,
  "discountPct" NUMERIC(5,2) NOT NULL DEFAULT 0,
  "taxRate" NUMERIC(5,2),
  total NUMERIC(14,2) NOT NULL,
  position INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_deal_items_deal ON deal_items("dealId");

-- ── Per-company setting: how a deal's `value` is derived ───────────────────
-- 'manual'   = user-entered value (default; preserves existing deal values)
-- 'items_sum'= deal value auto-recomputes from its deal_items total
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "dealValueMode" TEXT NOT NULL DEFAULT 'manual';
