-- Sprint 21 — Calendar Sync: connected Google Calendars (calendar.events), additive.
-- Mirrors email_inbox_connections (15D). sealedCreds = tokenCipher(JSON{refreshToken}).
-- syncToken carries Google's incremental-sync cursor (Phase B).
CREATE TABLE IF NOT EXISTS calendar_connections (
  id TEXT PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'google',   -- google (outlook later)
  "emailAddress" TEXT NOT NULL,
  "calendarId" TEXT NOT NULL DEFAULT 'primary',
  "sealedCreds" TEXT NOT NULL,               -- tokenCipher(JSON)
  status TEXT NOT NULL DEFAULT 'active',      -- active | error | disconnected
  "lastError" TEXT,
  "lastSyncAt" TIMESTAMPTZ,
  "syncToken" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calendar_conn_company_idx ON calendar_connections("companyId");
CREATE UNIQUE INDEX IF NOT EXISTS calendar_conn_uq ON calendar_connections("companyId","userId",provider,"emailAddress");
