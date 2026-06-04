-- Sprint 5 — Google Workspace Integration (Drive + Sheets)
-- Additive only. One Google connection per company (tenant = companyId).
-- Tokens are tokenCipher (AES-256-GCM) encrypted before storage; the single
-- TEXT columns hold a JSON-serialized SealedToken { ciphertext, iv, tag }.
-- Apply via: prisma db execute --file (idempotent — IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS google_connections (
  id              TEXT PRIMARY KEY,
  "companyId"     TEXT NOT NULL UNIQUE,
  "googleEmail"   TEXT NOT NULL,
  "accessToken"   TEXT NOT NULL,        -- tokenCipher encrypted (JSON SealedToken)
  "refreshToken"  TEXT NOT NULL,        -- tokenCipher encrypted (JSON SealedToken)
  scope           TEXT NOT NULL,
  "expiryDate"    TIMESTAMPTZ,
  "driveFolderId" TEXT,                 -- the "Zyrix CRM" folder we create
  status          TEXT NOT NULL DEFAULT 'active',  -- active | revoked
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_google_connections_company ON google_connections("companyId");
