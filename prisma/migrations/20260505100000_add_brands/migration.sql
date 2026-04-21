CREATE TABLE IF NOT EXISTS "brands" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "logoUrl" TEXT,
  "primaryColor" TEXT,
  "description" TEXT,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "isArchived" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "brands_companyId_slug_key" ON "brands"("companyId", "slug");
CREATE INDEX IF NOT EXISTS "brands_companyId_idx" ON "brands"("companyId");
CREATE INDEX IF NOT EXISTS "brands_companyId_isArchived_idx" ON "brands"("companyId", "isArchived");

-- Tag columns on entity tables (nullable — existing rows stay unbranded)
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "brandId" TEXT;
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "brandId" TEXT;
ALTER TABLE "activities" ADD COLUMN IF NOT EXISTS "brandId" TEXT;

CREATE INDEX IF NOT EXISTS "customers_companyId_brandId_idx" ON "customers"("companyId", "brandId");
CREATE INDEX IF NOT EXISTS "deals_companyId_brandId_idx" ON "deals"("companyId", "brandId");
CREATE INDEX IF NOT EXISTS "activities_companyId_brandId_idx" ON "activities"("companyId", "brandId");
