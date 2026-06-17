-- CAC Sprint 2B (Phase 2) — Planned (future) acquisition spend (raw SQL, tenant-scoped).
-- Additive + idempotent (CREATE TABLE / INDEX IF NOT EXISTS). Raw-SQL table (NO
-- Prisma model, accessed via $queryRawUnsafe — mirrors Sprint 18/19/20/24 +
-- Phase 1 acquisition_costs convention). NO `prisma db push`/`generate`, NO
-- schema.prisma change → backend tsc 11-baseline untouched.
--
-- APPLY ON RAILWAY via:  npx prisma db execute --file prisma/migrations/20260617120000_cac_sprint2b_planned_spend/migration.sql --schema prisma/schema.prisma
-- (Mehmet applies this. Claude never runs db push against prod.)
--
-- WHY a THIRD, SEPARATE table (locked scope):
--   • ad_spend_entries (Sprint 24)  = ACTUAL ad spend.        ← UNTOUCHED
--   • acquisition_costs (Phase 1)    = ACTUAL non-ad costs.    ← UNTOUCHED
--   • planned_acquisition_spend      = PLANNED future spend (ad + non-ad), by month.
--   computeMonthlyCac() reads ONLY the two ACTUAL tables and NEVER references this
--   one — so planned rows CANNOT affect actual CAC (zero regression, proven by the
--   throwaway-tenant verify before any consuming code ships). ONLY Sprint-3
--   forecasting reads this table.
--
-- PLANNED FX IS AN ESTIMATE: the future periodMonth rate is unknown, so the
-- consuming service resolves the LATEST manual/live rate AT ENTRY TIME (Sprint-23
-- resolveRateToBase with atDate = entry date, NOT the future month) and stamps
-- fxRateDate = that entry date + a fxRateSource flag. native amount + amountBase
-- are both stored so the estimate is re-derivable; amountBase is NULL (never a
-- guess) when no rate exists. The UI labels these figures as estimates.
--
-- ENTITLEMENT: reuses the existing `cac` key (ALL_ON) — NO new plan_features seed.

-- ── planned_acquisition_spend: planned future spend, ad + non-ad, by month ──
CREATE TABLE IF NOT EXISTS "planned_acquisition_spend" (
  "id"            TEXT NOT NULL,
  "companyId"     TEXT NOT NULL,
  "periodMonth"   DATE NOT NULL,                          -- normalized to first-of-month; the plan bucket
  "kind"          TEXT NOT NULL DEFAULT 'ad',             -- 'ad' | 'non_ad'
  "platform"      TEXT,                                   -- for kind='ad' (meta|google|tiktok|...|other); NULL for non_ad
  "category"      TEXT,                                   -- for kind='non_ad' (salary|commission|agency|event|content|tooling|other); NULL for ad
  "label"         TEXT,                                   -- planned campaign name / cost description
  "amount"        NUMERIC(14,2) NOT NULL,                 -- native planned amount as entered
  "currency"      TEXT NOT NULL,                          -- native currency (or base TRY directly)
  "amountBase"    NUMERIC(14,2),                          -- ESTIMATE in base (TRY) at entry-time rate; NULL when no rate (never guessed)
  "fxRateToBase"  NUMERIC(18,8),                          -- the estimate rate used
  "fxRateSource"  TEXT,                                   -- 'same' | 'manual' | 'live' | 'unavailable' (estimate flag)
  "fxRateDate"    DATE,                                   -- entry date the rate was struck (NOT the future month)
  "note"          TEXT,
  "createdById"   TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "planned_acquisition_spend_pkey" PRIMARY KEY ("id")
);

-- Forecast roll-up by month + by kind/platform group-bys (Sprint 3).
CREATE INDEX IF NOT EXISTS "planned_acquisition_spend_companyId_periodMonth_idx"
  ON "planned_acquisition_spend"("companyId","periodMonth");
CREATE INDEX IF NOT EXISTS "planned_acquisition_spend_companyId_kind_periodMonth_idx"
  ON "planned_acquisition_spend"("companyId","kind","periodMonth");
