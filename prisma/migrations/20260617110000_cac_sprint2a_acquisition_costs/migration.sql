-- CAC Sprint 2A (Phase 1) — Non-ad acquisition costs ledger (raw SQL, tenant-scoped).
-- Additive + idempotent (CREATE TABLE / INDEX IF NOT EXISTS). Raw-SQL table (NO
-- Prisma model, accessed via $queryRawUnsafe — mirrors the Sprint 18/19/20/24
-- tickets/KB/landing-pages/ad-spend convention; NO `prisma db push`/`generate`).
--
-- APPLY ON RAILWAY via:  npx prisma db execute --file prisma/migrations/20260617110000_cac_sprint2a_acquisition_costs/migration.sql --schema prisma/schema.prisma
-- (Mehmet applies this. Claude never runs db push against prod.)
--
-- WHY this table is NEW and SEPARATE (locked scope, Sprint 2):
--   • ad_spend_entries (Sprint 24) = ACTUAL ad-platform spend only. UNTOUCHED here,
--     so Sprint-1 CAC and Sprint-24 ROAS/CPA stay provably unchanged.
--   • deals.cost* (Sprint 23) = per-deal variable costs on won deals — wrong grain.
--   • Non-ad acquisition/marketing/sales costs (salaries, commissions attributable
--     to acquisition, agency retainers, events/booths, content, tooling, any manual
--     cost) had no home → this table. CAC's blended figure unions it in (Phase 1,
--     consuming code lands AFTER this SQL is applied).
--   • PLANNED future spend is a DIFFERENT table (planned_acquisition_spend, Sprint
--     2B / Phase 2) — kept out so this ledger is purely ACTUAL and CAC needs no
--     status filter.
--
-- FX → base (TRY): the consuming service reuses Sprint-23 resolveRateToBase /
-- convertSpend verbatim. amountBase is NULL (never a guess) when no rate exists,
-- surfacing a "set an exchange rate" badge — identical to deal & campaign economics.
--
-- ENTITLEMENT: reuses the existing `cac` key (ALL_ON) — NO new plan_features seed.

-- ── acquisition_costs: actual non-ad acquisition/marketing/sales costs ──
CREATE TABLE IF NOT EXISTS "acquisition_costs" (
  "id"            TEXT NOT NULL,
  "companyId"     TEXT NOT NULL,
  "costDate"      DATE NOT NULL,                          -- when incurred; drives the YYYY-MM bucket
  "category"      TEXT NOT NULL,                          -- salary | commission | agency | event | content | tooling | other
  "channel"       TEXT,                                   -- optional platform tag (meta|google|tiktok|...); NULL → "non_ad" bucket in per-channel CAC
  "amount"        NUMERIC(14,2) NOT NULL,                 -- native amount as entered
  "currency"      TEXT NOT NULL,                          -- native currency (or base TRY directly)
  "amountBase"    NUMERIC(14,2),                          -- converted to base (TRY); NULL when rate unavailable (honest, never guessed)
  "fxRateToBase"  NUMERIC(18,8),                          -- frozen native→base rate at costDate
  "fxRateSource"  TEXT,                                   -- 'same' | 'manual' | 'live' | 'unavailable'
  "fxRateDate"    DATE,                                   -- the FxRate date used
  "entryMode"     TEXT NOT NULL DEFAULT 'manual',         -- manual | api (parity with ad_spend_entries; manual today)
  "note"          TEXT,
  "createdById"   TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acquisition_costs_pkey" PRIMARY KEY ("id")
);

-- Monthly roll-up (CAC blended SUM) + per-channel + per-category group-bys.
CREATE INDEX IF NOT EXISTS "acquisition_costs_companyId_costDate_idx"
  ON "acquisition_costs"("companyId","costDate");
CREATE INDEX IF NOT EXISTS "acquisition_costs_companyId_channel_costDate_idx"
  ON "acquisition_costs"("companyId","channel","costDate");
CREATE INDEX IF NOT EXISTS "acquisition_costs_companyId_category_costDate_idx"
  ON "acquisition_costs"("companyId","category","costDate");
