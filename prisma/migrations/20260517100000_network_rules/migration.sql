-- P8 — Platform-level network rules

CREATE TABLE IF NOT EXISTS "network_rules" (
  "id"        TEXT NOT NULL,
  "type"      TEXT NOT NULL,
  "label"     TEXT NOT NULL,
  "config"    JSONB NOT NULL,
  "active"    BOOLEAN NOT NULL DEFAULT true,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "network_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "network_rules_type_active_idx"
  ON "network_rules"("type", "active");
