-- Contract Management

CREATE TABLE IF NOT EXISTS "contracts" (
  "id"             TEXT PRIMARY KEY NOT NULL,
  "companyId"      TEXT NOT NULL,
  "customerId"     TEXT NOT NULL,
  "dealId"         TEXT,
  "createdById"    TEXT NOT NULL,

  "contractNumber" TEXT NOT NULL,
  "title"          TEXT NOT NULL,
  "description"    TEXT,
  "status"         TEXT NOT NULL DEFAULT 'draft',

  "startDate"      TIMESTAMP,
  "endDate"        TIMESTAMP,
  "renewalDate"    TIMESTAMP,
  "signedAt"       TIMESTAMP,

  "value"          DECIMAL(12,2) NOT NULL DEFAULT 0,
  "currency"       TEXT NOT NULL DEFAULT 'TRY',

  "fileUrl"        TEXT,
  "fileName"       TEXT,
  "notes"          TEXT,
  "terms"          TEXT,

  "reminderSent"   BOOLEAN NOT NULL DEFAULT false,

  "createdAt"      TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"      TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "contracts_companyId_fkey"    FOREIGN KEY ("companyId")    REFERENCES "companies"("id") ON DELETE CASCADE,
  CONSTRAINT "contracts_customerId_fkey"   FOREIGN KEY ("customerId")   REFERENCES "customers"("id") ON DELETE CASCADE,
  CONSTRAINT "contracts_dealId_fkey"       FOREIGN KEY ("dealId")       REFERENCES "deals"("id")     ON DELETE SET NULL,
  CONSTRAINT "contracts_createdById_fkey"  FOREIGN KEY ("createdById")  REFERENCES "users"("id")     ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS "contracts_companyId_idx"    ON "contracts"("companyId");
CREATE INDEX IF NOT EXISTS "contracts_customerId_idx"   ON "contracts"("customerId");
CREATE INDEX IF NOT EXISTS "contracts_dealId_idx"       ON "contracts"("dealId");
CREATE INDEX IF NOT EXISTS "contracts_status_idx"       ON "contracts"("status");
CREATE INDEX IF NOT EXISTS "contracts_endDate_idx"      ON "contracts"("endDate");
CREATE INDEX IF NOT EXISTS "contracts_renewalDate_idx"  ON "contracts"("renewalDate");
CREATE UNIQUE INDEX IF NOT EXISTS "contracts_companyId_contractNumber_key"
  ON "contracts"("companyId", "contractNumber");
