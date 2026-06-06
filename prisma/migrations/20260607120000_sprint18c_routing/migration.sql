-- ============================================================================
-- SPRINT 18 — PHASE C : CONVERSATION ROUTING
-- Additive only. Idempotent. Apply in Railway → Data → SQL.
-- ----------------------------------------------------------------------------
-- Opt-in auto-assign (default false). Round-robin reuses the existing
-- automation_rr_pointers table with scope='service_desk' — no new RR table.
-- ============================================================================

ALTER TABLE "service_desk_settings" ADD COLUMN IF NOT EXISTS "autoAssign" BOOLEAN NOT NULL DEFAULT false;
