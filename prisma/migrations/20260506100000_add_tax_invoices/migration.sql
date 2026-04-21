CREATE TABLE IF NOT EXISTS "tax_invoices" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "regime" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'standard',
  "invoiceNumber" TEXT NOT NULL,
  "quoteId" TEXT,
  "contractId" TEXT,
  "dealId" TEXT,
  "sellerName" TEXT NOT NULL,
  "sellerVatNo" TEXT,
  "sellerAddress" TEXT,
  "buyerName" TEXT NOT NULL,
  "buyerVatNo" TEXT,
  "buyerAddress" TEXT,
  "currency" TEXT NOT NULL DEFAULT 'SAR',
  "subtotal" DECIMAL(15,2) NOT NULL,
  "discountAmount" DECIMAL(15,2) NOT NULL DEFAULT 0,
  "taxRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
  "taxAmount" DECIMAL(15,2) NOT NULL,
  "totalAmount" DECIMAL(15,2) NOT NULL,
  "lineItems" JSONB NOT NULL DEFAULT '[]',
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "xml" TEXT,
  "qrCode" TEXT,
  "invoiceHash" TEXT,
  "previousInvoiceHash" TEXT,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "externalId" TEXT,
  "submittedAt" TIMESTAMP(3),
  "approvedAt" TIMESTAMP(3),
  "rejectionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tax_invoices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "tax_invoices_companyId_regime_invoiceNumber_key"
  ON "tax_invoices"("companyId", "regime", "invoiceNumber");
CREATE INDEX IF NOT EXISTS "tax_invoices_companyId_regime_idx"
  ON "tax_invoices"("companyId", "regime");
CREATE INDEX IF NOT EXISTS "tax_invoices_companyId_status_idx"
  ON "tax_invoices"("companyId", "status");
CREATE INDEX IF NOT EXISTS "tax_invoices_companyId_issuedAt_idx"
  ON "tax_invoices"("companyId", "issuedAt");
