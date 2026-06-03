-- ============================================================================
-- ZYRIX CRM — Sprint 2: Meta Lead Ads (Facebook/Instagram Instant Forms)
-- Run in Railway → Data tab → Query (idempotent — IF NOT EXISTS).
-- ----------------------------------------------------------------------------
-- ADDITIVE. Reuses existing customers/deals/companies. Does NOT touch any
-- existing table. Mirrors the WhatsApp inbox migration conventions.
-- ============================================================================

-- ──────────────────────────────────────────────────────────────────────
-- meta_lead_pages — maps a Facebook page_id → company so an app-level
-- `leadgen` webhook (which carries page_id, not company) routes to the right
-- tenant. Also holds the Page access token SEALED at rest (AES-256-GCM via
-- tokenCipher: ciphertext/iv/tag hex). A company "claims" a Page once.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "meta_lead_pages" (
  "id"              TEXT PRIMARY KEY NOT NULL,
  "companyId"       TEXT NOT NULL,
  "pageId"          TEXT NOT NULL,
  "pageName"        TEXT,
  "tokenCiphertext" TEXT,                              -- sealed Page token (hex)
  "tokenIv"         TEXT,
  "tokenTag"        TEXT,
  "status"          TEXT NOT NULL DEFAULT 'connected', -- connected | revoked
  "createdAt"       TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"       TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "meta_lead_pages_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "meta_lead_pages_pageId_key"
  ON "meta_lead_pages"("pageId");
CREATE INDEX IF NOT EXISTS "meta_lead_pages_companyId_idx" ON "meta_lead_pages"("companyId");

-- ──────────────────────────────────────────────────────────────────────
-- meta_lead_forms — optional cache of a lead form's field schema, so the UI
-- can show form names and the mapper can resolve field keys without a Graph
-- round-trip per lead. One row per (company, form).
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "meta_lead_forms" (
  "id"              TEXT PRIMARY KEY NOT NULL,
  "companyId"       TEXT NOT NULL,
  "formId"          TEXT NOT NULL,
  "pageId"          TEXT,
  "name"            TEXT,
  "fieldSchemaJson" JSONB NOT NULL DEFAULT '{}',
  "createdAt"       TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"       TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "meta_lead_forms_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "meta_lead_forms_companyId_formId_key"
  ON "meta_lead_forms"("companyId", "formId");
CREATE INDEX IF NOT EXISTS "meta_lead_forms_companyId_idx" ON "meta_lead_forms"("companyId");

-- ──────────────────────────────────────────────────────────────────────
-- lead_sources — attribution for a CRM contact/deal that originated from a
-- Meta Lead Ad. One row per submitted lead. `leadgenId` is UNIQUE → the
-- idempotency key: Meta retries INSERT ... ON CONFLICT (leadgenId) DO NOTHING
-- so no duplicate contacts/deals are created. `rawJson` keeps the full
-- field_data + attribution payload (no PII logged elsewhere).
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "lead_sources" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "companyId"   TEXT NOT NULL,
  "contactId"   TEXT,                               -- customers.id (upserted)
  "dealId"      TEXT,                               -- deals.id (created @ 'lead')
  "source"      TEXT NOT NULL DEFAULT 'meta_lead_ad',
  "leadgenId"   TEXT NOT NULL,                      -- Meta leadgen_id (idempotency)
  "campaignId"  TEXT,
  "adsetId"     TEXT,
  "adId"        TEXT,
  "formId"      TEXT,
  "pageId"      TEXT,
  "platform"    TEXT,                               -- fb | ig
  "rawJson"     JSONB NOT NULL DEFAULT '{}',
  "createdAt"   TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "lead_sources_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE,
  CONSTRAINT "lead_sources_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "customers"("id") ON DELETE SET NULL,
  CONSTRAINT "lead_sources_dealId_fkey"
    FOREIGN KEY ("dealId") REFERENCES "deals"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "lead_sources_leadgenId_key"
  ON "lead_sources"("leadgenId");
CREATE INDEX IF NOT EXISTS "lead_sources_companyId_idx" ON "lead_sources"("companyId");
CREATE INDEX IF NOT EXISTS "lead_sources_contactId_idx" ON "lead_sources"("contactId");
CREATE INDEX IF NOT EXISTS "lead_sources_dealId_idx" ON "lead_sources"("dealId");
CREATE INDEX IF NOT EXISTS "lead_sources_createdAt_idx" ON "lead_sources"("createdAt");

-- ============================================================================
-- Verify:
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema='public'
--     AND table_name IN ('meta_lead_pages','meta_lead_forms','lead_sources');
-- Expected: 3 rows
-- ============================================================================
