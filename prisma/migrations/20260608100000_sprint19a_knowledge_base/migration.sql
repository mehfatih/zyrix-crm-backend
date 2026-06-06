-- ============================================================================
-- SPRINT 19 — PHASE A : KNOWLEDGE BASE (Articles + Categories)
-- Additive only. Idempotent (IF NOT EXISTS). Apply in Railway → Data → SQL.
-- ----------------------------------------------------------------------------
-- New tables: kb_categories, kb_articles (raw-SQL, relation-free — accessed via
-- $queryRawUnsafe, mirroring the Sprint 18 tickets pattern).
-- Plus: plan_features rows for the new feature key `knowledge_base` so the admin
-- god-mode matrix + per-plan auto-activation (Sprint 16 system) pick it up.
-- Default mirrors FEATURE_CATALOG: knowledge_base = STARTER_UP. limitValue NULL.
-- Title/body are per-locale JSONB {en,ar,tr}. Tenant scope = companyId.
-- ============================================================================

-- ── kb_categories ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "kb_categories" (
  "id"        TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "slug"      TEXT NOT NULL,
  "name"      JSONB NOT NULL DEFAULT '{}',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "kb_categories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "kb_categories_companyId_slug_key"
  ON "kb_categories" ("companyId", "slug");
CREATE INDEX IF NOT EXISTS "kb_categories_companyId_sortOrder_idx"
  ON "kb_categories" ("companyId", "sortOrder");

-- ── kb_articles ──────────────────────────────────────────────────────────────
-- status: draft | published. body stored as per-locale Markdown text.
CREATE TABLE IF NOT EXISTS "kb_articles" (
  "id"          TEXT NOT NULL,
  "companyId"   TEXT NOT NULL,
  "slug"        TEXT NOT NULL,
  "categoryId"  TEXT,
  "status"      TEXT NOT NULL DEFAULT 'draft',
  "title"       JSONB NOT NULL DEFAULT '{}',
  "body"        JSONB NOT NULL DEFAULT '{}',
  "viewCount"   INTEGER NOT NULL DEFAULT 0,
  "helpfulYes"  INTEGER NOT NULL DEFAULT 0,
  "helpfulNo"   INTEGER NOT NULL DEFAULT 0,
  "createdById" TEXT,
  "publishedAt" TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "kb_articles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "kb_articles_companyId_slug_key"
  ON "kb_articles" ("companyId", "slug");
CREATE INDEX IF NOT EXISTS "kb_articles_companyId_status_idx"
  ON "kb_articles" ("companyId", "status");
CREATE INDEX IF NOT EXISTS "kb_articles_companyId_categoryId_idx"
  ON "kb_articles" ("companyId", "categoryId");

-- ── plan_features rows for the new key (mirror FEATURE_CATALOG default) ───────
-- knowledge_base → STARTER_UP (free off; starter/business/enterprise on)
INSERT INTO "plan_features" ("id","plan","featureKey","enabled","limitValue","updatedAt","createdAt")
VALUES
  (gen_random_uuid()::text, 'free',       'knowledge_base', false, NULL, NOW(), NOW()),
  (gen_random_uuid()::text, 'starter',    'knowledge_base', true,  NULL, NOW(), NOW()),
  (gen_random_uuid()::text, 'business',   'knowledge_base', true,  NULL, NOW(), NOW()),
  (gen_random_uuid()::text, 'enterprise', 'knowledge_base', true,  NULL, NOW(), NOW())
ON CONFLICT ("plan","featureKey")
DO UPDATE SET "enabled" = EXCLUDED."enabled",
              "limitValue" = EXCLUDED."limitValue",
              "updatedAt" = NOW();
