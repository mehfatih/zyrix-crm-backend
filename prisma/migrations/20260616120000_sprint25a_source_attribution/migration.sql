-- Sprint 25A — Order/Deal Source Attribution (where did this deal come from?).
-- Additive + idempotent (every statement IF NOT EXISTS / ON CONFLICT). Raw-SQL
-- only — NO Prisma model changes, accessed via $queryRawUnsafe (mirrors Sprint
-- 23/24 deal_economics / campaign_economics; NO `prisma db push` / `generate`).
--
-- APPLY ON RAILWAY via:
--   npx prisma db execute --file "prisma/migrations/20260616120000_sprint25a_source_attribution/migration.sql" --schema "prisma/schema.prisma"
-- (Mehmet applies this. Claude never runs db push against prod.)
--
-- Four things land here:
--   1. lead_sources extension — new nullable attribution columns (clickId, utm*,
--      captureMethod, landingPageId, dedupeKey) so non-lead-ad rows (landing-page
--      UTM, CTWA/Messenger referral, manual) can record into the SAME rich audit
--      ledger that Meta/Google lead ads already write to.
--   2. lead_sources uniqueness RELAXED — leadgenId becomes nullable so non-lead-ad
--      rows can insert. See the long note below on WHY the existing unique index is
--      kept as-is (NULL-distinct) rather than converted to a partial index.
--   3. deals.attributionSource + deals.attributionCaptureMethod — thin raw read-model
--      columns (NOT in the Deal Prisma model; set/read via raw SQL — exactly like
--      deals.adCampaignId from Sprint 24). The fast read model; lead_sources stays
--      the rich per-touch audit ledger.
--   4. plan_features seed for the new `source_attribution` entitlement key (STARTER_UP
--      — the lead-gen hook: everyone on starter+ can tag/see order source). The
--      ROAS/CPA/net-profit rollup stays under campaign_economics (BUSINESS_UP).

-- ── 1. lead_sources: new attribution columns (all nullable, additive) ──
-- These extend the existing Meta/Google lead-ad ledger so landing-UTM, CTWA,
-- Messenger-referral, and manual captures all write into one place. rawJson keeps
-- everything else (utm_term/utm_content, the full referral object, etc.).
ALTER TABLE "lead_sources" ADD COLUMN IF NOT EXISTS "clickId"       TEXT;  -- fbclid | gclid | ttclid | msclkid | …
ALTER TABLE "lead_sources" ADD COLUMN IF NOT EXISTS "utmSource"     TEXT;
ALTER TABLE "lead_sources" ADD COLUMN IF NOT EXISTS "utmMedium"     TEXT;
ALTER TABLE "lead_sources" ADD COLUMN IF NOT EXISTS "utmCampaign"   TEXT;
ALTER TABLE "lead_sources" ADD COLUMN IF NOT EXISTS "captureMethod" TEXT;  -- 'auto' | 'manual'
ALTER TABLE "lead_sources" ADD COLUMN IF NOT EXISTS "landingPageId" TEXT;  -- logical FK → landing_pages.id (relation-free)
-- Synthetic dedup key for NON-leadgen rows (landing-UTM / CTWA / Messenger), so a
-- page refresh or a webhook retry doesn't insert the same touch twice. The app
-- computes a deterministic key (e.g. 'landing_utm:<clickId|utmCampaign|dealId>').
-- leadgen rows leave this NULL and dedup on leadgenId as before.
ALTER TABLE "lead_sources" ADD COLUMN IF NOT EXISTS "dedupeKey"     TEXT;

-- ── 2. Relax lead_sources uniqueness so non-lead-ad rows can insert ──
-- leadgenId was TEXT NOT NULL UNIQUE (Meta/Google idempotency key). Non-lead-ad
-- attribution rows have no leadgenId, so drop the NOT NULL.
ALTER TABLE "lead_sources" ALTER COLUMN "leadgenId" DROP NOT NULL;
--
-- DELIBERATE DEVIATION from the STOP-1 brief (flagged for Mehmet):
-- The brief said "make uniqueness conditional on leadgenId IS NOT NULL (partial
-- unique index)". We KEEP the existing standard unique index "lead_sources_leadgenId_key"
-- UNCHANGED and only drop NOT NULL — because in Postgres a STANDARD unique index
-- already treats NULLs as DISTINCT, so it is *already* "uniqueness conditional on
-- leadgenId IS NOT NULL" in effect: many NULL-leadgenId rows are allowed, non-NULL
-- ones stay unique. Same data outcome as a partial index.
--
-- WHY NOT a literal partial index: the live Meta + Google ingest do
-- `INSERT … ON CONFLICT ("leadgenId") DO NOTHING`. Postgres arbiter-index inference
-- for a PARTIAL unique index requires the ON CONFLICT to repeat the index predicate
-- (`… ON CONFLICT ("leadgenId") WHERE "leadgenId" IS NOT NULL`). Converting the index
-- to partial would therefore BREAK those two statements until a matching code deploy
-- lands — and since the predicate'd form fails against the *current* (non-partial)
-- index, there's no single code version that works across the apply window. Keeping
-- the standard index avoids that co-deploy hazard entirely with no behavioral cost.
-- (If Mehmet still wants the literal partial index, say so and I'll switch + patch
--  both ON CONFLICT sites + sequence the deploy.)

-- Synthetic-key uniqueness for non-leadgen rows only (tenant-scoped). Partial so it
-- never touches leadgen rows (which dedup on leadgenId) and ignores rows that don't
-- set a key. This is the idempotency backstop for landing-UTM / CTWA captures.
CREATE UNIQUE INDEX IF NOT EXISTS "lead_sources_companyId_dedupeKey_key"
  ON "lead_sources"("companyId","dedupeKey")
  WHERE "leadgenId" IS NULL AND "dedupeKey" IS NOT NULL;

-- Helpful read indexes for the new attribution dimensions.
CREATE INDEX IF NOT EXISTS "lead_sources_companyId_source_idx"
  ON "lead_sources"("companyId","source");
CREATE INDEX IF NOT EXISTS "lead_sources_companyId_utmSource_idx"
  ON "lead_sources"("companyId","utmSource");

-- ── 3. deals: thin raw attribution read-model columns ──
-- Raw columns only (NOT added to the Deal Prisma model) — Prisma ignores unknown
-- columns; set/read via raw SQL, exactly like deals.adCampaignId (Sprint 24).
--   attributionSource        — normalized source token (e.g. 'meta_lead_ad',
--                              'google_ads_lead', 'ctwa_ad', 'messenger_ad',
--                              'landing_utm', or a platform token for manual tags).
--   attributionCaptureMethod — 'auto' | 'manual'. Manual is NEVER overwritten by
--                              auto (precedence enforced in the service layer).
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "attributionSource"        TEXT;
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "attributionCaptureMethod" TEXT;
CREATE INDEX IF NOT EXISTS "deals_companyId_attributionSource_idx"
  ON "deals"("companyId","attributionSource");

-- ── 4. plan_features seed for the new entitlement key (STARTER_UP) ──
-- Matches FEATURE_CATALOG default for source_attribution: free off; starter /
-- business / enterprise on. Gates auto-capture + the manual source dropdown — the
-- lead-gen hook. (ROAS/CPA/net-profit math stays under campaign_economics, BUSINESS_UP.)
INSERT INTO "plan_features" ("id","plan","featureKey","enabled","limitValue","updatedAt","createdAt")
VALUES
  (gen_random_uuid()::text, 'free',       'source_attribution', false, NULL, NOW(), NOW()),
  (gen_random_uuid()::text, 'starter',    'source_attribution', true,  NULL, NOW(), NOW()),
  (gen_random_uuid()::text, 'business',   'source_attribution', true,  NULL, NOW(), NOW()),
  (gen_random_uuid()::text, 'enterprise', 'source_attribution', true,  NULL, NOW(), NOW())
ON CONFLICT ("plan","featureKey")
DO UPDATE SET "enabled" = EXCLUDED."enabled",
              "limitValue" = EXCLUDED."limitValue",
              "updatedAt" = NOW();

-- ============================================================================
-- Verify (expect the noted results):
--   -- new lead_sources columns (expect 7 rows):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name='lead_sources'
--      AND column_name IN ('clickId','utmSource','utmMedium','utmCampaign','captureMethod','landingPageId','dedupeKey')
--    ORDER BY column_name;
--   -- leadgenId now nullable (expect is_nullable = YES):
--   SELECT is_nullable FROM information_schema.columns
--    WHERE table_name='lead_sources' AND column_name='leadgenId';
--   -- deals columns (expect 2 rows):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name='deals'
--      AND column_name IN ('attributionSource','attributionCaptureMethod') ORDER BY 1;
--   -- entitlement seed (expect 4 rows; free=f, others=t):
--   SELECT plan, enabled FROM plan_features WHERE "featureKey"='source_attribution' ORDER BY plan;
-- ============================================================================
