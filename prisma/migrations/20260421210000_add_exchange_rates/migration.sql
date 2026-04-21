-- Multi-Currency Reports — exchange rates per company

CREATE TABLE IF NOT EXISTS "exchange_rates" (
  "id"           TEXT PRIMARY KEY NOT NULL,
  "companyId"    TEXT NOT NULL,

  "fromCurrency" TEXT NOT NULL,
  "toCurrency"   TEXT NOT NULL,
  "rate"         DECIMAL(14,6) NOT NULL,

  "effectiveAt"  TIMESTAMP NOT NULL DEFAULT NOW(),

  "createdAt"    TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"    TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "exchange_rates_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "exchange_rates_companyId_idx"    ON "exchange_rates"("companyId");
CREATE INDEX IF NOT EXISTS "exchange_rates_fromCurrency_idx" ON "exchange_rates"("fromCurrency");
CREATE INDEX IF NOT EXISTS "exchange_rates_toCurrency_idx"   ON "exchange_rates"("toCurrency");
CREATE UNIQUE INDEX IF NOT EXISTS "exchange_rates_companyId_fromCurrency_toCurrency_key"
  ON "exchange_rates"("companyId", "fromCurrency", "toCurrency");
