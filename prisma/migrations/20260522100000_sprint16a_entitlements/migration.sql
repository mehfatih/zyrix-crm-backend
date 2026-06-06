-- Sprint 16A — Entitlement core (additive only; safe to run multiple times).
-- Single source of truth for plan→feature access. Seeded from
-- FEATURE_CATALOG.defaultByPlan + the limit matrix; per-tenant 3-state overrides.

-- Per-plan default matrix (booleans + numeric limits).
CREATE TABLE IF NOT EXISTS "plan_features" (
  "id"         TEXT NOT NULL,
  "plan"       TEXT NOT NULL,
  "featureKey" TEXT NOT NULL,
  "enabled"    BOOLEAN NOT NULL DEFAULT false,
  "limitValue" INTEGER,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "plan_features_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "plan_features_plan_featureKey_key"
  ON "plan_features" ("plan", "featureKey");
CREATE INDEX IF NOT EXISTS "plan_features_plan_idx"
  ON "plan_features" ("plan");

-- Per-tenant 3-state override (inherit | force_on | force_off) + limit override.
CREATE TABLE IF NOT EXISTS "company_feature_overrides" (
  "id"            TEXT NOT NULL,
  "companyId"     TEXT NOT NULL,
  "featureKey"    TEXT NOT NULL,
  "mode"          TEXT NOT NULL DEFAULT 'inherit',
  "limitOverride" INTEGER,
  "updatedBy"     TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "company_feature_overrides_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "company_feature_overrides_companyId_featureKey_key"
  ON "company_feature_overrides" ("companyId", "featureKey");
CREATE INDEX IF NOT EXISTS "company_feature_overrides_companyId_idx"
  ON "company_feature_overrides" ("companyId");

-- FK to companies (cascade on delete). Guard so re-runs don't error.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'company_feature_overrides_companyId_fkey'
  ) THEN
    ALTER TABLE "company_feature_overrides"
      ADD CONSTRAINT "company_feature_overrides_companyId_fkey"
      FOREIGN KEY ("companyId") REFERENCES "companies"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
