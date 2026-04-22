-- P5 — Custom data retention policies

CREATE TABLE IF NOT EXISTS "retention_policies" (
  "id"              TEXT NOT NULL,
  "companyId"       TEXT NOT NULL,
  "entityType"      TEXT NOT NULL,
  "retentionDays"   INTEGER NOT NULL,
  "legalHold"       BOOLEAN NOT NULL DEFAULT false,
  "legalHoldReason" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "retention_policies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "retention_policies_companyId_entityType_key"
  ON "retention_policies"("companyId", "entityType");
CREATE INDEX IF NOT EXISTS "retention_policies_companyId_idx"
  ON "retention_policies"("companyId");
