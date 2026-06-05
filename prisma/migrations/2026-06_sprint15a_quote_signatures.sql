-- Sprint 15 Phase A — Quote e-signature (additive)
CREATE TABLE IF NOT EXISTS quote_signatures (
  id TEXT PRIMARY KEY,
  "quoteId" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "signerName" TEXT NOT NULL,
  "signerEmail" TEXT,
  "signatureImage" TEXT NOT NULL,        -- base64 PNG data URL
  "signedAtUtc" TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quote_signatures_quote_idx ON quote_signatures("quoteId");
CREATE INDEX IF NOT EXISTS quote_signatures_company_idx ON quote_signatures("companyId");

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "signatureRequired" BOOLEAN NOT NULL DEFAULT false;
