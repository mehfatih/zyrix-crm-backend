-- P2 — Audit Logs expansion: before/after snapshots + session correlation

ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "before"    JSONB;
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "after"     JSONB;
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "sessionId" TEXT;

CREATE INDEX IF NOT EXISTS "audit_logs_sessionId_idx"
  ON "audit_logs"("sessionId");
