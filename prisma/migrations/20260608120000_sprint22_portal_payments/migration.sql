-- Sprint 22 — Portal Payments (Pay now on quotes inside the customer portal).
-- Additive + idempotent. NO new tables: reuses the Sprint-15E payments-collect
-- rails (payment_connections / payment_requests). This migration only seeds the
-- plan_features rows for the new entitlement key so the resolver matches the
-- FEATURE_CATALOG default (STARTER_UP: free off; starter/business/enterprise on).

INSERT INTO "plan_features" ("id","plan","featureKey","enabled","limitValue","updatedAt","createdAt")
VALUES
  (gen_random_uuid()::text, 'free',       'portal_payments', false, NULL, NOW(), NOW()),
  (gen_random_uuid()::text, 'starter',    'portal_payments', true,  NULL, NOW(), NOW()),
  (gen_random_uuid()::text, 'business',   'portal_payments', true,  NULL, NOW(), NOW()),
  (gen_random_uuid()::text, 'enterprise', 'portal_payments', true,  NULL, NOW(), NOW())
ON CONFLICT ("plan","featureKey")
DO UPDATE SET "enabled" = EXCLUDED."enabled",
              "limitValue" = EXCLUDED."limitValue",
              "updatedAt" = NOW();
