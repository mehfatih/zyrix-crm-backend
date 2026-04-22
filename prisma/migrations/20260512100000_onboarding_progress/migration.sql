-- P3 — Onboarding wizard per-step progress

ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "onboardingProgress" JSONB NOT NULL DEFAULT '{}';
