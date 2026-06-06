-- Sprint 15 Phase D — connected email inboxes (Gmail OAuth + IMAP), additive
CREATE TABLE IF NOT EXISTS email_inbox_connections (
  id TEXT PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  provider TEXT NOT NULL,                 -- gmail | imap
  "emailAddress" TEXT NOT NULL,
  "sealedCreds" TEXT NOT NULL,            -- tokenCipher(JSON)
  status TEXT NOT NULL DEFAULT 'active',  -- active | error | disconnected
  "lastError" TEXT,
  "lastSyncAt" TIMESTAMPTZ,
  cursor TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_inbox_company_idx ON email_inbox_connections("companyId");
CREATE UNIQUE INDEX IF NOT EXISTS email_inbox_uq ON email_inbox_connections("companyId","userId",provider,"emailAddress");
