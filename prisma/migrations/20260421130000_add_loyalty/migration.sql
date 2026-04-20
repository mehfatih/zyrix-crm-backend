-- Customer Loyalty — per-company program + per-customer points ledger

CREATE TABLE IF NOT EXISTS "loyalty_programs" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "companyId"   TEXT NOT NULL,

  "name"        TEXT NOT NULL DEFAULT 'Loyalty Program',
  "isActive"    BOOLEAN NOT NULL DEFAULT true,
  "pointsPerUnit" DECIMAL(10,4) NOT NULL DEFAULT 1,
  "currency"    TEXT NOT NULL DEFAULT 'TRY',
  "minRedeem"   INTEGER NOT NULL DEFAULT 0,
  "redeemValue" DECIMAL(10,4) NOT NULL DEFAULT 0.01,

  "tiers"       JSONB,
  "rules"       JSONB,

  "createdAt"   TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"   TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "loyalty_programs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "loyalty_programs_companyId_key" ON "loyalty_programs"("companyId");

-- Points ledger — positive = earn, negative = redeem/adjust
CREATE TABLE IF NOT EXISTS "loyalty_transactions" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "companyId"   TEXT NOT NULL,
  "customerId"  TEXT NOT NULL,
  "programId"   TEXT NOT NULL,
  "createdById" TEXT,

  "points"      INTEGER NOT NULL,
  "type"        TEXT NOT NULL DEFAULT 'earn', -- earn | redeem | adjust | expire
  "reason"      TEXT,
  "referenceType" TEXT,
  "referenceId" TEXT,

  "createdAt"   TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "loyalty_transactions_companyId_fkey"  FOREIGN KEY ("companyId")  REFERENCES "companies"("id") ON DELETE CASCADE,
  CONSTRAINT "loyalty_transactions_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE,
  CONSTRAINT "loyalty_transactions_programId_fkey"  FOREIGN KEY ("programId")  REFERENCES "loyalty_programs"("id") ON DELETE CASCADE,
  CONSTRAINT "loyalty_transactions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "loyalty_transactions_companyId_idx"  ON "loyalty_transactions"("companyId");
CREATE INDEX IF NOT EXISTS "loyalty_transactions_customerId_idx" ON "loyalty_transactions"("customerId");
CREATE INDEX IF NOT EXISTS "loyalty_transactions_programId_idx"  ON "loyalty_transactions"("programId");
CREATE INDEX IF NOT EXISTS "loyalty_transactions_type_idx"       ON "loyalty_transactions"("type");
CREATE INDEX IF NOT EXISTS "loyalty_transactions_createdAt_idx"  ON "loyalty_transactions"("createdAt");
