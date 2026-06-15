-- Sprint 23A — Deal Economics (currency-stamping + COGS + per-deal profitability).
-- Additive + idempotent (every statement IF NOT EXISTS / ON CONFLICT). NO new
-- tables, NO new Prisma models — only columns on the existing deals/deal_items
-- tables + the plan_features seed for the new `deal_economics` entitlement key.
--
-- APPLY ON RAILWAY via:  npx prisma db execute --file prisma/migrations/20260615100000_sprint23a_deal_economics/migration.sql --schema prisma/schema.prisma
-- (Mehmet applies this. Claude never runs db push against prod; types are synced
--  locally with `prisma generate` only.)

-- ── deals: frozen-at-close FX stamp (immutable once set) + editable variable costs ──
-- baseCurrency / fxRateToBase / fxRateDate / fxRateSource / baseValue / cogsBase
-- are stamped once at close and never silently change. The cost* columns are
-- merchant-editable post-close; gross profit + margin are computed on read.
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "baseCurrency"       TEXT;
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "fxRateToBase"       NUMERIC(18,8);
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "fxRateDate"         DATE;
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "fxRateSource"       TEXT;          -- 'same' | 'manual' | 'live' | 'unavailable'
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "baseValue"          NUMERIC(14,2);
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "cogsBase"           NUMERIC(14,2);
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "costShipping"       NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "costPaymentFee"     NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "costAdSpend"        NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "costOther"          NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "economicsStampedAt" TIMESTAMP(3);

-- ── deal_items: product cost snapshot at add-time (frozen per line) ──
-- unitCost is snapshotted from product.cost; costCurrency from product.currency.
-- NULL unitCost = unknown cost (no product link or product had no cost set).
ALTER TABLE "deal_items" ADD COLUMN IF NOT EXISTS "unitCost"     NUMERIC(14,2);
ALTER TABLE "deal_items" ADD COLUMN IF NOT EXISTS "costCurrency" TEXT;

-- ── plan_features seed for the new entitlement key (BUSINESS_UP) ──
-- Matches FEATURE_CATALOG default: free/starter off, business/enterprise on.
INSERT INTO "plan_features" ("id","plan","featureKey","enabled","limitValue","updatedAt","createdAt")
VALUES
  (gen_random_uuid()::text, 'free',       'deal_economics', false, NULL, NOW(), NOW()),
  (gen_random_uuid()::text, 'starter',    'deal_economics', false, NULL, NOW(), NOW()),
  (gen_random_uuid()::text, 'business',   'deal_economics', true,  NULL, NOW(), NOW()),
  (gen_random_uuid()::text, 'enterprise', 'deal_economics', true,  NULL, NOW(), NOW())
ON CONFLICT ("plan","featureKey")
DO UPDATE SET "enabled" = EXCLUDED."enabled",
              "limitValue" = EXCLUDED."limitValue",
              "updatedAt" = NOW();
