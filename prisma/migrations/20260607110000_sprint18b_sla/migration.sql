-- ============================================================================
-- SPRINT 18 — PHASE B : SLA ENGINE
-- Additive only. Idempotent (IF NOT EXISTS). Apply in Railway → Data → SQL.
-- ----------------------------------------------------------------------------
-- 24/7 v1: timers run continuously. businessHours JSONB ships nullable
-- (null = 24/7) and is wired in a later pass. The chosen preset is stored on
-- service_desk_settings.defaultSlaPolicyId (single source of selection).
-- ============================================================================

-- ── sla_policies ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "sla_policies" (
  "id"                TEXT NOT NULL,
  "companyId"         TEXT NOT NULL,
  "name"              TEXT NOT NULL,
  "firstResponseMins" INTEGER NOT NULL,
  "resolveMins"       INTEGER NOT NULL,
  "businessHours"     JSONB,
  "escalateToUserId"  TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sla_policies_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "sla_policies_companyId_idx" ON "sla_policies" ("companyId");

-- ── tickets SLA columns ────────────────────────────────────────────────────
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "slaPolicyId"        TEXT;
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "firstResponseDueAt" TIMESTAMP(3);
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "resolveDueAt"       TIMESTAMP(3);
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "slaBreachedAt"      TIMESTAMP(3);
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "slaState"           TEXT;
-- Queue "breaching-soon" filter + near-breach badge read slaState.
CREATE INDEX IF NOT EXISTS "tickets_companyId_slaState_idx" ON "tickets" ("companyId", "slaState");

-- ── service_desk_settings: which preset the merchant picked ─────────────────
ALTER TABLE "service_desk_settings" ADD COLUMN IF NOT EXISTS "defaultSlaPolicyId" TEXT;
