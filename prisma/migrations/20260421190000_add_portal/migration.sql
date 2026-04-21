-- Customer Portal — magic-link tokens for customer self-service

CREATE TABLE IF NOT EXISTS "portal_tokens" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "customerId"  TEXT NOT NULL,
  "companyId"   TEXT NOT NULL,

  "token"       TEXT NOT NULL,
  "purpose"     TEXT NOT NULL DEFAULT 'login', -- login | session
  "expiresAt"   TIMESTAMP NOT NULL,
  "usedAt"      TIMESTAMP,

  "ipAddress"   TEXT,
  "userAgent"   TEXT,

  "createdAt"   TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "portal_tokens_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE,
  CONSTRAINT "portal_tokens_companyId_fkey"  FOREIGN KEY ("companyId")  REFERENCES "companies"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "portal_tokens_token_key" ON "portal_tokens"("token");
CREATE INDEX IF NOT EXISTS "portal_tokens_customerId_idx" ON "portal_tokens"("customerId");
CREATE INDEX IF NOT EXISTS "portal_tokens_companyId_idx"  ON "portal_tokens"("companyId");
CREATE INDEX IF NOT EXISTS "portal_tokens_expiresAt_idx"  ON "portal_tokens"("expiresAt");
