-- ============================================================================
-- Features: Email Templates + Custom Fields + Shopify Integration
-- Activity timeline uses existing activities table + enhanced filters
-- ============================================================================

-- ──────────────────────────────────────────────────────────────────────
-- EMAIL TEMPLATES — reusable templates for campaigns
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "email_templates" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "companyId"   TEXT NOT NULL,
  "createdById" TEXT NOT NULL,

  "name"        TEXT NOT NULL,
  "description" TEXT,
  "category"    TEXT NOT NULL DEFAULT 'general',
  "subject"     TEXT NOT NULL,
  "bodyHtml"    TEXT NOT NULL,
  "bodyText"    TEXT,

  "variables"   JSONB NOT NULL DEFAULT '[]',
  "isShared"    BOOLEAN NOT NULL DEFAULT true,
  "usageCount"  INTEGER NOT NULL DEFAULT 0,

  "createdAt"   TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"   TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "email_templates_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE,
  CONSTRAINT "email_templates_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION
);
CREATE INDEX IF NOT EXISTS "email_templates_companyId_idx" ON "email_templates"("companyId");
CREATE INDEX IF NOT EXISTS "email_templates_category_idx" ON "email_templates"("category");

-- ──────────────────────────────────────────────────────────────────────
-- CUSTOM FIELDS — company-defined fields for customers + deals
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "custom_fields" (
  "id"            TEXT PRIMARY KEY NOT NULL,
  "companyId"     TEXT NOT NULL,

  "entityType"    TEXT NOT NULL,
  "fieldKey"      TEXT NOT NULL,
  "label"         TEXT NOT NULL,
  "fieldType"     TEXT NOT NULL DEFAULT 'text',
  "options"       JSONB,
  "required"      BOOLEAN NOT NULL DEFAULT false,
  "defaultValue"  TEXT,
  "position"      INTEGER NOT NULL DEFAULT 0,
  "isActive"      BOOLEAN NOT NULL DEFAULT true,

  "createdAt"     TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"     TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "custom_fields_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "custom_fields_companyId_idx" ON "custom_fields"("companyId");
CREATE INDEX IF NOT EXISTS "custom_fields_entityType_idx" ON "custom_fields"("entityType");
CREATE UNIQUE INDEX IF NOT EXISTS "custom_fields_companyId_entityType_fieldKey_key"
  ON "custom_fields"("companyId", "entityType", "fieldKey");

-- ──────────────────────────────────────────────────────────────────────
-- Custom field values stored as JSONB on existing entities
-- Added columns if not present
-- ──────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'customers' AND column_name = 'customFields') THEN
    ALTER TABLE "customers" ADD COLUMN "customFields" JSONB NOT NULL DEFAULT '{}';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'deals' AND column_name = 'customFields') THEN
    ALTER TABLE "deals" ADD COLUMN "customFields" JSONB NOT NULL DEFAULT '{}';
  END IF;
END $$;

-- ──────────────────────────────────────────────────────────────────────
-- SHOPIFY STORE CONNECTION — per-company Shopify credentials
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "shopify_stores" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "companyId"   TEXT NOT NULL,

  "shopDomain"  TEXT NOT NULL,
  "accessToken" TEXT NOT NULL,
  "isActive"    BOOLEAN NOT NULL DEFAULT true,

  "lastSyncAt"  TIMESTAMP,
  "syncStatus"  TEXT NOT NULL DEFAULT 'idle',
  "syncError"   TEXT,
  "totalCustomersImported" INTEGER NOT NULL DEFAULT 0,
  "totalOrdersImported"    INTEGER NOT NULL DEFAULT 0,

  "createdAt"   TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"   TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "shopify_stores_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "shopify_stores_companyId_shopDomain_key" ON "shopify_stores"("companyId", "shopDomain");
CREATE INDEX IF NOT EXISTS "shopify_stores_companyId_idx" ON "shopify_stores"("companyId");

-- Mark imported customers with source
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'customers' AND column_name = 'source') THEN
    ALTER TABLE "customers" ADD COLUMN "source" TEXT;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'customers' AND column_name = 'externalId') THEN
    ALTER TABLE "customers" ADD COLUMN "externalId" TEXT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "customers_source_idx" ON "customers"("source");
CREATE INDEX IF NOT EXISTS "customers_externalId_idx" ON "customers"("externalId");
