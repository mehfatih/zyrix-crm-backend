-- Sprint 11 — Cadences + Journeys
-- ADDITIVE ONLY. Safe to re-run (IF NOT EXISTS everywhere).
-- Apply in Railway → Data → SQL console (batch), and locally via
--   npx prisma db execute --file prisma/migrations/2026-06_sprint11_cadences.sql --schema prisma/schema.prisma
-- then `npx prisma generate`. Do NOT run prisma migrate/db push.

-- ── Cadences (linear follow-up sequences; compile to a versioned workflow) ──
CREATE TABLE IF NOT EXISTS cadences (
  id TEXT PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  steps TEXT NOT NULL,            -- JSON [{channel: whatsapp|email|task|call_task, delayDays, delayHours, templateRef|subject|body, name}]
  "exitRules" TEXT NOT NULL,      -- JSON {onReply:true, onDealWon:true, onUnsubscribe:true}
  status TEXT NOT NULL DEFAULT 'draft',   -- draft | active | paused
  "automationId" TEXT,            -- compiled engine workflow id (latest version)
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cadences_company ON cadences("companyId", status);

CREATE TABLE IF NOT EXISTS cadence_enrollments (
  id TEXT PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  "cadenceId" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "runId" TEXT,                   -- engine execution running this enrollment
  "currentStep" INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',  -- active | exited | completed
  "exitReason" TEXT,              -- replied | deal_won | manual | unsubscribed | completed
  "enrolledAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "endedAt" TIMESTAMPTZ
);
-- One ACTIVE enrollment per (cadence, contact); re-enroll allowed after exit.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cadence_enroll_active ON cadence_enrollments("cadenceId", "contactId") WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_cadence_enroll_contact ON cadence_enrollments("companyId", "contactId", status);
CREATE INDEX IF NOT EXISTS idx_cadence_enroll_run ON cadence_enrollments("runId");

CREATE TABLE IF NOT EXISTS cadence_step_stats (
  id TEXT PRIMARY KEY,
  "cadenceId" TEXT NOT NULL,
  "stepIndex" INT NOT NULL,
  sent INT NOT NULL DEFAULT 0,
  opened INT NOT NULL DEFAULT 0,
  clicked INT NOT NULL DEFAULT 0,
  replied INT NOT NULL DEFAULT 0,
  UNIQUE("cadenceId", "stepIndex")
);

-- ── Journeys reuse the workflows table (one engine). kind distinguishes them;
--    canvas holds the visual node/edge layout. ('automation' = classic workflow.)
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'automation'; -- automation | journey | cadence
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "canvas" TEXT;  -- JSON {nodes:[{id,type,x,y,config}], edges:[{from,to,label?}]}
