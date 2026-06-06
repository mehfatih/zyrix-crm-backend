-- Sprint 15 Phase E — per-company payment collection (iyzico + HyperPay), additive.
-- Separate from the platform subscription-billing Payment model (untouched).
CREATE TABLE IF NOT EXISTS payment_connections (
  id TEXT PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  provider TEXT NOT NULL,              -- iyzico | hyperpay
  "sealedKeys" TEXT NOT NULL,          -- tokenCipher(JSON)
  currency CHAR(3) NOT NULL,
  sandbox BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_connections_uq ON payment_connections("companyId", provider);

CREATE TABLE IF NOT EXISTS payment_requests (
  id TEXT PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  provider TEXT NOT NULL,
  "quoteId" TEXT,
  "invoiceId" TEXT,
  amount DECIMAL(12,2) NOT NULL,
  currency CHAR(3) NOT NULL,
  "externalId" TEXT,
  "checkoutUrl" TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | failed | expired
  events JSONB NOT NULL DEFAULT '[]',
  "paidAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_requests_company_idx ON payment_requests("companyId","createdAt");
CREATE INDEX IF NOT EXISTS payment_requests_external_idx ON payment_requests("externalId");
CREATE INDEX IF NOT EXISTS payment_requests_quote_idx ON payment_requests("quoteId");
