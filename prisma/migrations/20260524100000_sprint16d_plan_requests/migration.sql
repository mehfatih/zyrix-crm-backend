-- Sprint 16D — in-app plan change requests (additive; safe to re-run).
CREATE TABLE IF NOT EXISTS "plan_change_requests" (
  "id"                TEXT NOT NULL,
  "companyId"         TEXT NOT NULL,
  "currentPlan"       TEXT NOT NULL,
  "requestedPlan"     TEXT NOT NULL,
  "status"            TEXT NOT NULL DEFAULT 'pending',
  "note"              TEXT,
  "requestedByUserId" TEXT,
  "decidedByAdminId"  TEXT,
  "decidedAt"         TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "plan_change_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "plan_change_requests_status_createdAt_idx"
  ON "plan_change_requests" ("status", "createdAt");
CREATE INDEX IF NOT EXISTS "plan_change_requests_companyId_status_idx"
  ON "plan_change_requests" ("companyId", "status");
