-- Sprint 24A — Campaign Economics (per-campaign ad-spend + ROAS/CPA in base currency).
-- Additive + idempotent (every statement IF NOT EXISTS / ON CONFLICT). Raw-SQL
-- tables (NO Prisma model, accessed via $queryRawUnsafe — mirrors the Sprint
-- 18/19/20 tickets/KB/landing-pages convention; NO `prisma db push`/`generate`).
--
-- APPLY ON RAILWAY via:  npx prisma db execute --file prisma/migrations/20260615110000_sprint24a_campaign_economics/migration.sql --schema prisma/schema.prisma
-- (Mehmet applies this. Claude never runs db push against prod.)
--
-- Three things land here:
--   1. ad_campaigns       — the UNIFIED ad-campaign object across all 6 platforms
--                           (meta/google/tiktok/snapchat/twitter/linkedin). One row
--                           per campaign regardless of source. `externalId` is the
--                           ad-platform campaign id, the match key to
--                           lead_sources.campaignId for revenue rollup.
--   2. ad_spend_entries   — spend rows. The SAME table for manual entry today AND
--                           future direct-API pulls (entryMode 'manual'|'api'); a
--                           native-currency amount is converted to base (TRY) via
--                           the Sprint-23 FX engine, frozen at spendDate. amountBase
--                           is NULL when no rate exists (honest "set a rate", never a
--                           guess — mirrors Sprint 23 deal economics).
--   3. deals.adCampaignId — optional explicit deal→campaign tag, so revenue rollup =
--                           lead_sources auto-match OR this manual tag (essential for
--                           the 4 platforms with no lead-capture integration).
-- Plus the plan_features seed for the new `campaign_economics` entitlement key.

-- ── ad_campaigns: unified campaign object across all platforms ──
CREATE TABLE IF NOT EXISTS "ad_campaigns" (
  "id"              TEXT NOT NULL,
  "companyId"       TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "platform"        TEXT NOT NULL,                       -- meta | google | tiktok | snapchat | twitter | linkedin | other
  "externalId"      TEXT,                                -- ad-platform campaign id; match key to lead_sources.campaignId; NULL for manual-only
  "accountCurrency" TEXT,                                -- ad account native currency (default for new spend rows)
  "status"          TEXT NOT NULL DEFAULT 'active',      -- active | paused | archived
  "objective"       TEXT,
  "targetRoas"      NUMERIC(10,2),                        -- ROAS alert threshold (revenue/spend); NULL = no alert
  "targetCpa"       NUMERIC(14,2),                        -- CPA alert threshold (base currency); NULL = no alert
  "alertsEnabled"   BOOLEAN NOT NULL DEFAULT false,
  "createdById"     TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ad_campaigns_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ad_campaigns_companyId_idx" ON "ad_campaigns"("companyId");
CREATE INDEX IF NOT EXISTS "ad_campaigns_companyId_platform_idx" ON "ad_campaigns"("companyId","platform");
-- One row per real platform campaign (lets the future API upsert dedupe); manual
-- campaigns carry NULL externalId and are exempt from the constraint.
CREATE UNIQUE INDEX IF NOT EXISTS "ad_campaigns_companyId_platform_externalId_key"
  ON "ad_campaigns"("companyId","platform","externalId") WHERE "externalId" IS NOT NULL;

-- ── ad_spend_entries: spend rows (manual today, API-ready) ──
CREATE TABLE IF NOT EXISTS "ad_spend_entries" (
  "id"            TEXT NOT NULL,
  "companyId"     TEXT NOT NULL,
  "adCampaignId"  TEXT NOT NULL,                          -- logical FK → ad_campaigns.id (relation-free, like landing_page_events)
  "platform"      TEXT NOT NULL,                          -- denormalized from the campaign for fast group-by
  "spendDate"     DATE NOT NULL,                          -- daily amount or bank-withdrawal date
  "amount"        NUMERIC(14,2) NOT NULL,                 -- native amount as entered
  "currency"      TEXT NOT NULL,                          -- native currency (or base TRY directly)
  "amountBase"    NUMERIC(14,2),                          -- converted to base (TRY); NULL when rate unavailable
  "fxRateToBase"  NUMERIC(18,8),                          -- frozen native→base rate at spendDate
  "fxRateSource"  TEXT,                                   -- 'same' | 'manual' | 'live' | 'unavailable'
  "fxRateDate"    DATE,                                   -- the FxRate date used
  "entryMode"     TEXT NOT NULL DEFAULT 'manual',         -- manual | api
  "externalId"    TEXT,                                   -- platform spend/insight id; dedup key for future API pulls
  "note"          TEXT,
  "createdById"   TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ad_spend_entries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ad_spend_entries_companyId_adCampaignId_spendDate_idx"
  ON "ad_spend_entries"("companyId","adCampaignId","spendDate");
CREATE INDEX IF NOT EXISTS "ad_spend_entries_companyId_platform_spendDate_idx"
  ON "ad_spend_entries"("companyId","platform","spendDate");
-- Idempotency for the future direct-API pull (manual rows carry NULL externalId).
CREATE UNIQUE INDEX IF NOT EXISTS "ad_spend_entries_companyId_platform_externalId_key"
  ON "ad_spend_entries"("companyId","platform","externalId") WHERE "externalId" IS NOT NULL;

-- ── deals: optional explicit campaign tag (revenue rollup fallback) ──
-- Raw column only (NOT added to the Deal Prisma model) — Prisma ignores unknown
-- columns, set/read via raw SQL. Auto-attribution still flows through lead_sources;
-- this is the manual override for platforms with no lead-capture integration.
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "adCampaignId" TEXT;
CREATE INDEX IF NOT EXISTS "deals_adCampaignId_idx" ON "deals"("adCampaignId");

-- ── plan_features seed for the new entitlement key (BUSINESS_UP) ──
-- Matches FEATURE_CATALOG default: free/starter off, business/enterprise on.
INSERT INTO "plan_features" ("id","plan","featureKey","enabled","limitValue","updatedAt","createdAt")
VALUES
  (gen_random_uuid()::text, 'free',       'campaign_economics', false, NULL, NOW(), NOW()),
  (gen_random_uuid()::text, 'starter',    'campaign_economics', false, NULL, NOW(), NOW()),
  (gen_random_uuid()::text, 'business',   'campaign_economics', true,  NULL, NOW(), NOW()),
  (gen_random_uuid()::text, 'enterprise', 'campaign_economics', true,  NULL, NOW(), NOW())
ON CONFLICT ("plan","featureKey")
DO UPDATE SET "enabled" = EXCLUDED."enabled",
              "limitValue" = EXCLUDED."limitValue",
              "updatedAt" = NOW();
