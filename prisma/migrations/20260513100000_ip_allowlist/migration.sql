-- P4 — IP Allowlisting

CREATE TABLE IF NOT EXISTS "ip_allowlist" (
  "id"        TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "cidr"      TEXT NOT NULL,
  "label"     TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ip_allowlist_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ip_allowlist_companyId_idx"
  ON "ip_allowlist"("companyId");
