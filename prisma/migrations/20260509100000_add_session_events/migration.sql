CREATE TABLE IF NOT EXISTS "session_events" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "session_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "session_events_companyId_userId_createdAt_idx"
  ON "session_events"("companyId", "userId", "createdAt");
CREATE INDEX IF NOT EXISTS "session_events_companyId_eventType_createdAt_idx"
  ON "session_events"("companyId", "eventType", "createdAt");
CREATE INDEX IF NOT EXISTS "session_events_userId_createdAt_idx"
  ON "session_events"("userId", "createdAt");

ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "idleTimeoutMinutes" INTEGER DEFAULT 10;
