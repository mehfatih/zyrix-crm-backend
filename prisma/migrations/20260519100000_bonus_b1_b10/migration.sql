-- B1-B10 — Customer score fields + Territory / Quota / Meeting /
-- ContractSignature / SlackWebhook models

ALTER TABLE "customers"
  ADD COLUMN IF NOT EXISTS "leadScore" INTEGER,
  ADD COLUMN IF NOT EXISTS "leadScoreUpdatedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "healthScore" INTEGER,
  ADD COLUMN IF NOT EXISTS "healthScoreUpdatedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "territory" TEXT;

-- Territories
CREATE TABLE IF NOT EXISTS "territories" (
  "id"        TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "criteria"  JSONB NOT NULL DEFAULT '{}',
  "ownerId"   TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "territories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "territories_companyId_name_key"
  ON "territories"("companyId", "name");
CREATE INDEX IF NOT EXISTS "territories_companyId_idx"
  ON "territories"("companyId");

-- Quotas
CREATE TABLE IF NOT EXISTS "quotas" (
  "id"        TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "period"    TEXT NOT NULL,
  "target"    DECIMAL(14, 2) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "quotas_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "quotas_companyId_userId_period_key"
  ON "quotas"("companyId", "userId", "period");
CREATE INDEX IF NOT EXISTS "quotas_companyId_idx"
  ON "quotas"("companyId");

-- Meetings
CREATE TABLE IF NOT EXISTS "meetings" (
  "id"          TEXT NOT NULL,
  "companyId"   TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "customerId"  TEXT,
  "dealId"      TEXT,
  "title"       TEXT NOT NULL,
  "transcript"  TEXT NOT NULL,
  "summary"     TEXT,
  "actionItems" JSONB NOT NULL DEFAULT '[]',
  "meetingAt"   TIMESTAMP(3) NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "meetings_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "meetings_companyId_meetingAt_idx"
  ON "meetings"("companyId", "meetingAt");

-- Contract signatures
CREATE TABLE IF NOT EXISTS "contract_signatures" (
  "id"              TEXT NOT NULL,
  "companyId"       TEXT NOT NULL,
  "contractId"      TEXT NOT NULL,
  "signerEmail"     TEXT NOT NULL,
  "signerName"      TEXT,
  "signatureDataUrl" TEXT,
  "token"           TEXT NOT NULL,
  "tokenExpiresAt"  TIMESTAMP(3) NOT NULL,
  "requestedBy"     TEXT NOT NULL,
  "requestedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "signedAt"        TIMESTAMP(3),
  CONSTRAINT "contract_signatures_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "contract_signatures_token_key"
  ON "contract_signatures"("token");
CREATE INDEX IF NOT EXISTS "contract_signatures_contractId_idx"
  ON "contract_signatures"("contractId");
CREATE INDEX IF NOT EXISTS "contract_signatures_token_idx"
  ON "contract_signatures"("token");

-- Slack/Teams outgoing webhook per company
CREATE TABLE IF NOT EXISTS "slack_webhooks" (
  "id"         TEXT NOT NULL,
  "companyId"  TEXT NOT NULL,
  "url"        TEXT NOT NULL,
  "eventTypes" JSONB NOT NULL DEFAULT '[]',
  "addedBy"    TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "slack_webhooks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "slack_webhooks_companyId_key"
  ON "slack_webhooks"("companyId");
