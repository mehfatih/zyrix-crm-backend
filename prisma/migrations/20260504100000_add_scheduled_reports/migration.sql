CREATE TABLE IF NOT EXISTS "scheduled_reports" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "cadence" TEXT NOT NULL,
  "hour" INTEGER NOT NULL DEFAULT 9,
  "dayOfWeek" INTEGER,
  "dayOfMonth" INTEGER,
  "metrics" JSONB NOT NULL DEFAULT '[]',
  "recipients" JSONB NOT NULL DEFAULT '[]',
  "isEnabled" BOOLEAN NOT NULL DEFAULT true,
  "lastRunAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "scheduled_reports_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "scheduled_reports_companyId_idx"
  ON "scheduled_reports"("companyId");
CREATE INDEX IF NOT EXISTS "scheduled_reports_companyId_isEnabled_idx"
  ON "scheduled_reports"("companyId", "isEnabled");
CREATE INDEX IF NOT EXISTS "scheduled_reports_isEnabled_cadence_idx"
  ON "scheduled_reports"("isEnabled", "cadence");
