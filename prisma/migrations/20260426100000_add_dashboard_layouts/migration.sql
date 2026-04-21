CREATE TABLE IF NOT EXISTS "dashboard_layouts" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "widgets" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "dashboard_layouts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "dashboard_layouts_companyId_userId_key"
  ON "dashboard_layouts"("companyId", "userId");
CREATE INDEX IF NOT EXISTS "dashboard_layouts_companyId_idx"
  ON "dashboard_layouts"("companyId");
