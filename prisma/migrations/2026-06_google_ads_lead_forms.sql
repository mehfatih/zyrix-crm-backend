-- ============================================================================
-- ZYRIX CRM — Sprint 7: Google Ads Lead Forms
-- Run in Railway → Data tab → Query (idempotent — IF NOT EXISTS).
-- ----------------------------------------------------------------------------
-- ADDITIVE. Reuses existing customers/deals/companies AND the existing
-- lead_sources table (created in Sprint 2 / 2026-06_meta_lead_ads.sql) — Google
-- Ads leads land there with source='google_ads_lead'. NO change to lead_sources;
-- this migration only adds the per-company config table. Mirrors the Meta Lead
-- Ads migration conventions.
-- ============================================================================

-- ──────────────────────────────────────────────────────────────────────
-- google_ads_configs — per-company settings for the Google Ads Lead Form
-- webhook. One row per company. `webhookKey` is the shared secret Google sends
-- back as `google_key`; it is SEALED at rest (AES-256-GCM via tokenCipher:
-- ciphertext/iv/tag hex) and shown in the UI (copy/rotate), never hashed.
-- `mapping` holds an optional JSON column_id → CRM-field override map (smart
-- defaults apply when null). `defaultPipelineStage` overrides the deal stage
-- new leads land in (defaults to 'lead', the first pipeline stage).
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "google_ads_configs" (
  "id"                   TEXT PRIMARY KEY NOT NULL,
  "companyId"            TEXT NOT NULL,
  "webhookKeyCiphertext" TEXT NOT NULL,                     -- sealed webhook key (hex)
  "webhookKeyIv"         TEXT NOT NULL,
  "webhookKeyTag"        TEXT NOT NULL,
  "mapping"              JSONB,                             -- column_id -> CRM field (null = smart defaults)
  "defaultPipelineStage" TEXT,                              -- null = 'lead'
  "status"               TEXT NOT NULL DEFAULT 'active',    -- active | disabled
  "createdAt"            TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"            TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "google_ads_configs_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "google_ads_configs_companyId_key"
  ON "google_ads_configs"("companyId");

-- ============================================================================
-- Verify:
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema='public' AND table_name = 'google_ads_configs';
-- Expected: 1 row
-- ============================================================================
