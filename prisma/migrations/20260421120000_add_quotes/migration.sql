-- Quotes & Proposals — customer-facing formal price proposals

CREATE TABLE IF NOT EXISTS "quotes" (
  "id"           TEXT PRIMARY KEY NOT NULL,
  "companyId"    TEXT NOT NULL,
  "customerId"   TEXT NOT NULL,
  "dealId"       TEXT,
  "createdById"  TEXT NOT NULL,

  "quoteNumber"  TEXT NOT NULL,
  "title"        TEXT NOT NULL,
  "status"       TEXT NOT NULL DEFAULT 'draft',

  "issuedAt"     TIMESTAMP,
  "validUntil"   TIMESTAMP,
  "acceptedAt"   TIMESTAMP,
  "rejectedAt"   TIMESTAMP,
  "sentAt"       TIMESTAMP,

  "currency"     TEXT NOT NULL DEFAULT 'TRY',
  "subtotal"     DECIMAL(12,2) NOT NULL DEFAULT 0,
  "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "taxAmount"    DECIMAL(12,2) NOT NULL DEFAULT 0,
  "total"        DECIMAL(12,2) NOT NULL DEFAULT 0,

  "notes"        TEXT,
  "terms"        TEXT,

  "publicToken"  TEXT,
  "viewedAt"     TIMESTAMP,

  "createdAt"    TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"    TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "quotes_companyId_fkey"    FOREIGN KEY ("companyId")    REFERENCES "companies"("id") ON DELETE CASCADE,
  CONSTRAINT "quotes_customerId_fkey"   FOREIGN KEY ("customerId")   REFERENCES "customers"("id") ON DELETE CASCADE,
  CONSTRAINT "quotes_dealId_fkey"       FOREIGN KEY ("dealId")       REFERENCES "deals"("id")     ON DELETE SET NULL,
  CONSTRAINT "quotes_createdById_fkey"  FOREIGN KEY ("createdById")  REFERENCES "users"("id")     ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS "quotes_companyId_idx"   ON "quotes"("companyId");
CREATE INDEX IF NOT EXISTS "quotes_customerId_idx"  ON "quotes"("customerId");
CREATE INDEX IF NOT EXISTS "quotes_dealId_idx"      ON "quotes"("dealId");
CREATE INDEX IF NOT EXISTS "quotes_status_idx"      ON "quotes"("status");
CREATE INDEX IF NOT EXISTS "quotes_createdById_idx" ON "quotes"("createdById");
CREATE INDEX IF NOT EXISTS "quotes_validUntil_idx"  ON "quotes"("validUntil");

-- Unique constraint on quoteNumber per company
CREATE UNIQUE INDEX IF NOT EXISTS "quotes_companyId_quoteNumber_key" ON "quotes"("companyId", "quoteNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "quotes_publicToken_key" ON "quotes"("publicToken") WHERE "publicToken" IS NOT NULL;

-- Line items
CREATE TABLE IF NOT EXISTS "quote_items" (
  "id"            TEXT PRIMARY KEY NOT NULL,
  "quoteId"       TEXT NOT NULL,

  "name"          TEXT NOT NULL,
  "description"   TEXT,
  "quantity"      DECIMAL(12,3) NOT NULL DEFAULT 1,
  "unitPrice"     DECIMAL(12,2) NOT NULL DEFAULT 0,
  "discountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
  "taxPercent"    DECIMAL(5,2) NOT NULL DEFAULT 0,
  "lineTotal"     DECIMAL(12,2) NOT NULL DEFAULT 0,
  "position"      INTEGER NOT NULL DEFAULT 0,

  "createdAt"     TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "quote_items_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "quotes"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "quote_items_quoteId_idx" ON "quote_items"("quoteId");
