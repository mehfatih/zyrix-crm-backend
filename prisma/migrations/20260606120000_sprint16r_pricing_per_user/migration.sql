-- Sprint 16R — Pricing restructure to PER-USER model (additive/idempotent; safe to re-run).
-- Owner-approved business decision: move from flat per-company pricing to per-user/month.
--   limit_users ceilings: Free 2 (hard) / Starter 20 / Business 100 / Enterprise ∞ (NULL).
--   plans table TRY prices retuned to per-user rates (Monthly = monthly-billed rate;
--   Yearly = annual-billed per-user rate × 12). USD/SAR are display approximations for the
--   internal admin MRR dashboard only — ₺ is authoritative (multi-currency display deferred).
-- Live-tenant safety: both active tenants are enterprise → zero price/limit impact.

-- ── 1. plan_features: limit_users ceilings ────────────────────────────────
UPDATE "plan_features" SET "limitValue" = 2,    "updatedAt" = NOW() WHERE "plan" = 'free'       AND "featureKey" = 'limit_users';
UPDATE "plan_features" SET "limitValue" = 20,   "updatedAt" = NOW() WHERE "plan" = 'starter'    AND "featureKey" = 'limit_users';
UPDATE "plan_features" SET "limitValue" = 100,  "updatedAt" = NOW() WHERE "plan" = 'business'   AND "featureKey" = 'limit_users';
UPDATE "plan_features" SET "limitValue" = NULL, "updatedAt" = NOW() WHERE "plan" = 'enterprise' AND "featureKey" = 'limit_users';

-- ── 2. plans: per-user prices + maxUsers caps ─────────────────────────────
UPDATE "plans" SET
  "maxUsers" = 2,
  "updatedAt" = NOW()
WHERE "slug" = 'free';

UPDATE "plans" SET
  "priceMonthlyTry" = 499,  "priceYearlyTry" = 4788,
  "priceMonthlyUsd" = 13,   "priceYearlyUsd" = 125,
  "priceMonthlySar" = 49,   "priceYearlySar" = 466,
  "maxUsers" = 20,
  "updatedAt" = NOW()
WHERE "slug" = 'starter';

UPDATE "plans" SET
  "priceMonthlyTry" = 1099, "priceYearlyTry" = 10788,
  "priceMonthlyUsd" = 29,   "priceYearlyUsd" = 280,
  "priceMonthlySar" = 107,  "priceYearlySar" = 1051,
  "maxUsers" = 100,
  "updatedAt" = NOW()
WHERE "slug" = 'business';

-- enterprise: custom pricing (kept 0) + unlimited users (kept 999999); no change needed.
