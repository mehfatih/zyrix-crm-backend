-- ============================================================================
-- Generalize integrations — rename shopify_stores -> ecommerce_stores
-- Add support for 40+ e-commerce platforms (MENA + Turkey)
-- ============================================================================

-- Rename shopify_stores table to ecommerce_stores (keeping data)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'shopify_stores')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables
                     WHERE table_schema = 'public' AND table_name = 'ecommerce_stores') THEN
    ALTER TABLE "shopify_stores" RENAME TO "ecommerce_stores";
  END IF;
END $$;

-- Create fresh table if neither exists (for new installations)
CREATE TABLE IF NOT EXISTS "ecommerce_stores" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "companyId"   TEXT NOT NULL,

  "platform"    TEXT NOT NULL DEFAULT 'shopify',
  "shopDomain"  TEXT NOT NULL,
  "accessToken" TEXT NOT NULL,
  "apiKey"      TEXT,
  "apiSecret"   TEXT,
  "region"      TEXT,
  "currency"    TEXT,
  "metadata"    JSONB NOT NULL DEFAULT '{}',

  "isActive"    BOOLEAN NOT NULL DEFAULT true,
  "lastSyncAt"  TIMESTAMP,
  "syncStatus"  TEXT NOT NULL DEFAULT 'idle',
  "syncError"   TEXT,
  "totalCustomersImported" INTEGER NOT NULL DEFAULT 0,
  "totalOrdersImported"    INTEGER NOT NULL DEFAULT 0,

  "createdAt"   TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"   TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "ecommerce_stores_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE
);

-- Add columns to ecommerce_stores if missing (for renamed table from shopify_stores)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'ecommerce_stores' AND column_name = 'platform') THEN
    ALTER TABLE "ecommerce_stores" ADD COLUMN "platform" TEXT NOT NULL DEFAULT 'shopify';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'ecommerce_stores' AND column_name = 'apiKey') THEN
    ALTER TABLE "ecommerce_stores" ADD COLUMN "apiKey" TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'ecommerce_stores' AND column_name = 'apiSecret') THEN
    ALTER TABLE "ecommerce_stores" ADD COLUMN "apiSecret" TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'ecommerce_stores' AND column_name = 'region') THEN
    ALTER TABLE "ecommerce_stores" ADD COLUMN "region" TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'ecommerce_stores' AND column_name = 'currency') THEN
    ALTER TABLE "ecommerce_stores" ADD COLUMN "currency" TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'ecommerce_stores' AND column_name = 'metadata') THEN
    ALTER TABLE "ecommerce_stores" ADD COLUMN "metadata" JSONB NOT NULL DEFAULT '{}';
  END IF;
END $$;

-- Unique + indexes
DROP INDEX IF EXISTS "shopify_stores_companyId_shopDomain_key";
DROP INDEX IF EXISTS "shopify_stores_companyId_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "ecommerce_stores_companyId_platform_shopDomain_key"
  ON "ecommerce_stores"("companyId", "platform", "shopDomain");
CREATE INDEX IF NOT EXISTS "ecommerce_stores_companyId_idx" ON "ecommerce_stores"("companyId");
CREATE INDEX IF NOT EXISTS "ecommerce_stores_platform_idx" ON "ecommerce_stores"("platform");
