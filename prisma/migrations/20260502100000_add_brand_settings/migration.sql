CREATE TABLE IF NOT EXISTS "brand_settings" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "displayName" TEXT,
  "logoUrl" TEXT,
  "faviconUrl" TEXT,
  "primaryColor" TEXT,
  "accentColor" TEXT,
  "emailFromName" TEXT,
  "emailFromAddress" TEXT,
  "customDomain" TEXT,
  "customDomainVerifiedAt" TIMESTAMP(3),
  "customDomainVerificationToken" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "brand_settings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "brand_settings_companyId_key" ON "brand_settings"("companyId");
CREATE UNIQUE INDEX IF NOT EXISTS "brand_settings_customDomain_key" ON "brand_settings"("customDomain");
CREATE INDEX IF NOT EXISTS "brand_settings_companyId_idx" ON "brand_settings"("companyId");
CREATE INDEX IF NOT EXISTS "brand_settings_customDomain_idx" ON "brand_settings"("customDomain");
