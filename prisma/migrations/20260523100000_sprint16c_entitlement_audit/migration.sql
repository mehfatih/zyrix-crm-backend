-- Sprint 16C — entitlement audit trail (additive; safe to re-run).
CREATE TABLE IF NOT EXISTS "entitlement_audit" (
  "id"         TEXT NOT NULL,
  "companyId"  TEXT NOT NULL,
  "actorId"    TEXT,
  "action"     TEXT NOT NULL,
  "featureKey" TEXT,
  "oldValue"   JSONB,
  "newValue"   JSONB,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "entitlement_audit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "entitlement_audit_companyId_createdAt_idx"
  ON "entitlement_audit" ("companyId", "createdAt");
