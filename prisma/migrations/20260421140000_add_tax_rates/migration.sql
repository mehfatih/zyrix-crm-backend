-- Tax Engine — per-company tax rate configuration
-- Supports Turkey KDV, Saudi/UAE/Egypt VAT, and custom rates

CREATE TABLE IF NOT EXISTS "tax_rates" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "companyId"   TEXT NOT NULL,

  "name"        TEXT NOT NULL,
  "code"        TEXT,
  "countryCode" TEXT,
  "ratePercent" DECIMAL(6,3) NOT NULL DEFAULT 0,
  "isDefault"   BOOLEAN NOT NULL DEFAULT false,
  "isActive"    BOOLEAN NOT NULL DEFAULT true,
  "description" TEXT,

  "createdAt"   TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"   TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "tax_rates_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "tax_rates_companyId_idx"   ON "tax_rates"("companyId");
CREATE INDEX IF NOT EXISTS "tax_rates_isActive_idx"    ON "tax_rates"("isActive");
CREATE INDEX IF NOT EXISTS "tax_rates_countryCode_idx" ON "tax_rates"("countryCode");
