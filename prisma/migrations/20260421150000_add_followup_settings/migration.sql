-- Smart Follow-up — per-company threshold configuration

CREATE TABLE IF NOT EXISTS "followup_settings" (
  "id"                 TEXT PRIMARY KEY NOT NULL,
  "companyId"          TEXT NOT NULL,

  "isEnabled"          BOOLEAN NOT NULL DEFAULT true,
  "warningDays"        INTEGER NOT NULL DEFAULT 5,
  "criticalDays"       INTEGER NOT NULL DEFAULT 10,
  "includeStatuses"    JSONB,
  "excludeInactive"    BOOLEAN NOT NULL DEFAULT true,

  "createdAt"          TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"          TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "followup_settings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "followup_settings_companyId_key" ON "followup_settings"("companyId");
