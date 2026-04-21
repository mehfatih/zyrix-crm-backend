CREATE TABLE IF NOT EXISTS "templates" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "industry" TEXT NOT NULL,
  "region" TEXT NOT NULL,
  "locale" TEXT NOT NULL DEFAULT 'en',
  "name" TEXT NOT NULL,
  "nameAr" TEXT,
  "nameTr" TEXT,
  "tagline" TEXT,
  "taglineAr" TEXT,
  "taglineTr" TEXT,
  "description" TEXT,
  "descriptionAr" TEXT,
  "descriptionTr" TEXT,
  "icon" TEXT NOT NULL DEFAULT '🧩',
  "color" TEXT NOT NULL DEFAULT '#0891B2',
  "isFeatured" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "bundle" JSONB NOT NULL,
  "setupMinutes" INTEGER NOT NULL DEFAULT 15,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "templates_slug_key" ON "templates"("slug");
CREATE INDEX IF NOT EXISTS "templates_industry_idx" ON "templates"("industry");
CREATE INDEX IF NOT EXISTS "templates_region_idx" ON "templates"("region");
CREATE INDEX IF NOT EXISTS "templates_isActive_isFeatured_idx"
  ON "templates"("isActive", "isFeatured");

CREATE TABLE IF NOT EXISTS "template_applications" (
  "id" TEXT NOT NULL,
  "templateId" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdRecords" JSONB NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'completed',
  "errorMessage" TEXT,
  "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "template_applications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "template_applications_companyId_idx"
  ON "template_applications"("companyId");
CREATE INDEX IF NOT EXISTS "template_applications_templateId_idx"
  ON "template_applications"("templateId");
CREATE INDEX IF NOT EXISTS "template_applications_companyId_appliedAt_idx"
  ON "template_applications"("companyId", "appliedAt");

ALTER TABLE "template_applications"
  ADD CONSTRAINT "template_applications_templateId_fkey"
  FOREIGN KEY ("templateId") REFERENCES "templates"("id") ON DELETE CASCADE;
