-- ============================================================================
-- ZYRIX CRM — Sprint 6: Automation Engine (extends the live workflows engine)
-- Run in Railway → Data tab → Query (idempotent — IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- ----------------------------------------------------------------------------
-- ADDITIVE ONLY. Builds on the EXISTING `workflows` / `workflow_executions` /
-- `territories` tables rather than introducing a parallel `automations` engine
-- (per STOP-1 reconciliation). Touches no existing column's type.
-- ============================================================================

-- ──────────────────────────────────────────────────────────────────────
-- territories — add round-robin assignment pools.
--   memberUserIds : JSON array of user ids that share leads in this territory
--   rrIndex       : round-robin pointer (atomically bumped via UPDATE ... RETURNING)
-- The pre-existing single `ownerId` stays as the territory-match default owner.
-- ──────────────────────────────────────────────────────────────────────
ALTER TABLE "territories"
  ADD COLUMN IF NOT EXISTS "memberUserIds" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "territories"
  ADD COLUMN IF NOT EXISTS "rrIndex" INTEGER NOT NULL DEFAULT 0;

-- ──────────────────────────────────────────────────────────────────────
-- automation_rr_pointers — company-level round-robin pointers for the
-- assign_owner action when it round-robins over the whole company (not a
-- territory). One row per (company, scope). `scope` is 'company' for the
-- default pool or a workflowId for a workflow-scoped pool. The pointer is
-- bumped atomically: INSERT ... ON CONFLICT DO UPDATE SET idx = idx + 1 RETURNING idx.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "automation_rr_pointers" (
  "companyId" TEXT NOT NULL,
  "scope"     TEXT NOT NULL DEFAULT 'company',
  "idx"       INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "automation_rr_pointers_pkey" PRIMARY KEY ("companyId", "scope"),
  CONSTRAINT "automation_rr_pointers_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE
);

-- ──────────────────────────────────────────────────────────────────────
-- workflow_executions — support first-class `wait` steps and the deal.idle
-- scan. A run that hits a wait step transitions to status='waiting' with
-- `scheduledAt` = resume time and `currentStep` = the cursor to resume from.
-- The worker claims due waiting rows (scheduledAt <= NOW()) alongside pending.
--   scheduledAt : next resume time for waiting runs (NULL otherwise)
--   currentStep : index into the action chain to resume execution from
-- ──────────────────────────────────────────────────────────────────────
ALTER TABLE "workflow_executions"
  ADD COLUMN IF NOT EXISTS "scheduledAt" TIMESTAMP;
ALTER TABLE "workflow_executions"
  ADD COLUMN IF NOT EXISTS "currentStep" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS "workflow_executions_status_scheduledAt_idx"
  ON "workflow_executions"("status", "scheduledAt");

-- ============================================================================
-- Verify:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name='territories' AND column_name IN ('memberUserIds','rrIndex');   -- 2 rows
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name='workflow_executions' AND column_name IN ('scheduledAt','currentStep'); -- 2 rows
--   SELECT to_regclass('public.automation_rr_pointers');                              -- not null
-- ============================================================================
