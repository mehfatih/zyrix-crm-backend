-- Commission Engine — rules + entries
-- Auto-creates entries when Deal transitions to 'won'

CREATE TABLE IF NOT EXISTS "commission_rules" (
  "id"             TEXT PRIMARY KEY NOT NULL,
  "companyId"      TEXT NOT NULL,

  "name"           TEXT NOT NULL,
  "description"    TEXT,
  "type"           TEXT NOT NULL DEFAULT 'percent', -- flat | percent | tiered
  "config"         JSONB NOT NULL,                  -- rule-specific: { rate, amount, tiers }
  "appliesTo"      TEXT NOT NULL DEFAULT 'all',     -- all | deal_stage | min_value
  "appliesToValue" TEXT,

  "isActive"       BOOLEAN NOT NULL DEFAULT true,
  "priority"       INTEGER NOT NULL DEFAULT 0,

  "createdAt"      TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"      TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "commission_rules_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "commission_rules_companyId_idx"  ON "commission_rules"("companyId");
CREATE INDEX IF NOT EXISTS "commission_rules_isActive_idx"   ON "commission_rules"("isActive");
CREATE INDEX IF NOT EXISTS "commission_rules_priority_idx"   ON "commission_rules"("priority");

CREATE TABLE IF NOT EXISTS "commission_entries" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "companyId"   TEXT NOT NULL,
  "ruleId"      TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "dealId"      TEXT NOT NULL,

  "baseValue"   DECIMAL(12,2) NOT NULL DEFAULT 0,
  "rate"        DECIMAL(8,4)  NOT NULL DEFAULT 0,
  "amount"      DECIMAL(12,2) NOT NULL DEFAULT 0,
  "currency"    TEXT NOT NULL DEFAULT 'TRY',

  "status"      TEXT NOT NULL DEFAULT 'pending', -- pending | approved | paid | cancelled
  "approvedAt"  TIMESTAMP,
  "paidAt"      TIMESTAMP,
  "notes"       TEXT,

  "createdAt"   TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"   TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "commission_entries_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE,
  CONSTRAINT "commission_entries_ruleId_fkey"    FOREIGN KEY ("ruleId")    REFERENCES "commission_rules"("id") ON DELETE CASCADE,
  CONSTRAINT "commission_entries_userId_fkey"    FOREIGN KEY ("userId")    REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "commission_entries_dealId_fkey"    FOREIGN KEY ("dealId")    REFERENCES "deals"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "commission_entries_companyId_idx" ON "commission_entries"("companyId");
CREATE INDEX IF NOT EXISTS "commission_entries_userId_idx"    ON "commission_entries"("userId");
CREATE INDEX IF NOT EXISTS "commission_entries_dealId_idx"    ON "commission_entries"("dealId");
CREATE INDEX IF NOT EXISTS "commission_entries_ruleId_idx"    ON "commission_entries"("ruleId");
CREATE INDEX IF NOT EXISTS "commission_entries_status_idx"    ON "commission_entries"("status");
CREATE UNIQUE INDEX IF NOT EXISTS "commission_entries_dealId_ruleId_userId_key"
  ON "commission_entries"("dealId", "ruleId", "userId");
