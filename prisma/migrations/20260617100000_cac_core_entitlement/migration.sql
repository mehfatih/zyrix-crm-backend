-- CAC Core (Sprint 1 of 3) — seed the `cac` entitlement ON for every plan.
-- CAC is a GIFT to all tiers (marketing/pricing feature), so plan_features is
-- enabled=true for free/starter/business/enterprise. It stays revokable per
-- company via company_feature_overrides (mode='force_off'). Additive + idempotent
-- (ON CONFLICT) — safe to re-run. Mirrors the Sprint 24/25 seed pattern.
--
-- NOTE: the resolver already falls back to FEATURE_CATALOG.defaultByPlan (ALL_ON)
-- if no row exists, so this seed is for admin-matrix / pricing consistency.

INSERT INTO "plan_features" ("id", "plan", "featureKey", "enabled", "limitValue", "updatedAt", "createdAt")
VALUES
  (gen_random_uuid()::text, 'free',       'cac', true, NULL, NOW(), NOW()),
  (gen_random_uuid()::text, 'starter',    'cac', true, NULL, NOW(), NOW()),
  (gen_random_uuid()::text, 'business',   'cac', true, NULL, NOW(), NOW()),
  (gen_random_uuid()::text, 'enterprise', 'cac', true, NULL, NOW(), NOW())
ON CONFLICT ("plan", "featureKey")
  DO UPDATE SET "enabled" = EXCLUDED."enabled",
                "limitValue" = EXCLUDED."limitValue",
                "updatedAt" = NOW();
