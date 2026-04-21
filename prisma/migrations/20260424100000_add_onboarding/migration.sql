-- ============================================================================
-- Onboarding wizard — adds company.baseCurrency, company.onboardingCompletedAt,
-- and user.preferredLocale so the wizard can persist its answers.
-- ============================================================================

-- Company columns
ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "baseCurrency" TEXT;

ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "onboardingCompletedAt" TIMESTAMP(3);

-- User locale preference
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "preferredLocale" TEXT;

-- Index so the dashboard can quickly filter 'companies that still need setup'
CREATE INDEX IF NOT EXISTS "companies_onboardingCompletedAt_idx"
  ON "companies" ("onboardingCompletedAt");
