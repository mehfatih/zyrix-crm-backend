-- ============================================================================
-- SPRINT 20 — PHASE A : LANDING PAGES (Page model + events)
-- Additive only. Idempotent (IF NOT EXISTS). Apply in Railway → Data → SQL.
-- ----------------------------------------------------------------------------
-- New tables: landing_pages, landing_page_events (raw-SQL, relation-free —
-- accessed via $queryRawUnsafe, mirroring the Sprint 18/19 tickets+KB pattern).
-- Plus: plan_features rows for the new LIMIT feature key `landing_pages` so the
-- admin god-mode matrix + per-plan auto-activation (Sprint 16 system) pick it up.
-- Default mirrors FEATURE_CATALOG: landing_pages is a LIMIT feature
--   enabled  → free off, starter/business/enterprise on
--   limit    → free 0, starter 1, business unlimited (NULL), enterprise NULL
-- Tenant scope = companyId. Page is single-locale; blocks/theme are JSONB.
-- ============================================================================

-- ── landing_pages ────────────────────────────────────────────────────────────
-- status: draft | published. blocks = ordered JSONB array [{id,type,props}].
-- theme  = JSONB {primaryColor,accentColor,logoUrl,font} (seeded from Branding).
-- formId references form_flows.id (the CTA form); metaPixelId optional.
CREATE TABLE IF NOT EXISTS "landing_pages" (
  "id"          TEXT NOT NULL,
  "companyId"   TEXT NOT NULL,
  "slug"        TEXT NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'draft',
  "locale"      TEXT NOT NULL DEFAULT 'ar',
  "title"       TEXT NOT NULL DEFAULT '',
  "blocks"      JSONB NOT NULL DEFAULT '[]',
  "theme"       JSONB NOT NULL DEFAULT '{}',
  "metaPixelId" TEXT,
  "formId"      TEXT,
  "viewCount"   INTEGER NOT NULL DEFAULT 0,
  "submitCount" INTEGER NOT NULL DEFAULT 0,
  "createdById" TEXT,
  "publishedAt" TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "landing_pages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "landing_pages_companyId_slug_key"
  ON "landing_pages" ("companyId", "slug");
CREATE INDEX IF NOT EXISTS "landing_pages_companyId_status_idx"
  ON "landing_pages" ("companyId", "status");

-- ── landing_page_events ──────────────────────────────────────────────────────
-- type: view | submit. One row per event; counters on landing_pages are the
-- fast denormalized totals, events table is the time-series for conversion %.
CREATE TABLE IF NOT EXISTS "landing_page_events" (
  "id"            TEXT NOT NULL,
  "companyId"     TEXT NOT NULL,
  "landingPageId" TEXT NOT NULL,
  "type"          TEXT NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "landing_page_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "landing_page_events_landingPageId_type_createdAt_idx"
  ON "landing_page_events" ("landingPageId", "type", "createdAt");

-- ── plan_features rows for the new key (mirror FEATURE_CATALOG default) ───────
-- landing_pages = LIMIT feature. enabled answers "has the capability at all";
-- limitValue carries the page cap (NULL = unlimited).
INSERT INTO "plan_features" ("id","plan","featureKey","enabled","limitValue","updatedAt","createdAt")
VALUES
  (gen_random_uuid()::text, 'free',       'landing_pages', false, 0,    NOW(), NOW()),
  (gen_random_uuid()::text, 'starter',    'landing_pages', true,  1,    NOW(), NOW()),
  (gen_random_uuid()::text, 'business',   'landing_pages', true,  NULL, NOW(), NOW()),
  (gen_random_uuid()::text, 'enterprise', 'landing_pages', true,  NULL, NOW(), NOW())
ON CONFLICT ("plan","featureKey")
DO UPDATE SET "enabled"    = EXCLUDED."enabled",
              "limitValue" = EXCLUDED."limitValue",
              "updatedAt"  = NOW();
