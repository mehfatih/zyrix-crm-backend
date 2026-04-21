-- Marketing Automation + Email Marketing — campaigns + recipients

CREATE TABLE IF NOT EXISTS "campaigns" (
  "id"           TEXT PRIMARY KEY NOT NULL,
  "companyId"    TEXT NOT NULL,
  "createdById"  TEXT NOT NULL,

  "name"         TEXT NOT NULL,
  "subject"      TEXT,
  "channel"      TEXT NOT NULL DEFAULT 'email', -- email | whatsapp | sms
  "status"       TEXT NOT NULL DEFAULT 'draft', -- draft | scheduled | sending | sent | failed | cancelled

  "bodyHtml"     TEXT,
  "bodyText"     TEXT,
  "fromName"     TEXT,
  "fromEmail"    TEXT,
  "replyTo"      TEXT,

  "targetType"   TEXT NOT NULL DEFAULT 'all',   -- all | status | tag | manual
  "targetValue"  TEXT,

  "scheduledAt"  TIMESTAMP,
  "sentAt"       TIMESTAMP,

  "recipientCount" INTEGER NOT NULL DEFAULT 0,
  "sentCount"      INTEGER NOT NULL DEFAULT 0,
  "deliveredCount" INTEGER NOT NULL DEFAULT 0,
  "openedCount"    INTEGER NOT NULL DEFAULT 0,
  "clickedCount"   INTEGER NOT NULL DEFAULT 0,
  "bouncedCount"   INTEGER NOT NULL DEFAULT 0,
  "failedCount"    INTEGER NOT NULL DEFAULT 0,

  "createdAt"    TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"    TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "campaigns_companyId_fkey"   FOREIGN KEY ("companyId")   REFERENCES "companies"("id") ON DELETE CASCADE,
  CONSTRAINT "campaigns_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS "campaigns_companyId_idx"   ON "campaigns"("companyId");
CREATE INDEX IF NOT EXISTS "campaigns_status_idx"      ON "campaigns"("status");
CREATE INDEX IF NOT EXISTS "campaigns_channel_idx"     ON "campaigns"("channel");
CREATE INDEX IF NOT EXISTS "campaigns_scheduledAt_idx" ON "campaigns"("scheduledAt");

CREATE TABLE IF NOT EXISTS "campaign_recipients" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "campaignId"  TEXT NOT NULL,
  "customerId"  TEXT NOT NULL,

  "email"       TEXT,
  "phone"       TEXT,

  "status"      TEXT NOT NULL DEFAULT 'queued', -- queued | sent | delivered | opened | clicked | bounced | failed
  "sentAt"      TIMESTAMP,
  "deliveredAt" TIMESTAMP,
  "openedAt"    TIMESTAMP,
  "clickedAt"   TIMESTAMP,
  "errorMessage" TEXT,

  "messageId"   TEXT,

  "createdAt"   TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"   TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "campaign_recipients_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE,
  CONSTRAINT "campaign_recipients_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "campaign_recipients_campaignId_idx" ON "campaign_recipients"("campaignId");
CREATE INDEX IF NOT EXISTS "campaign_recipients_customerId_idx" ON "campaign_recipients"("customerId");
CREATE INDEX IF NOT EXISTS "campaign_recipients_status_idx"     ON "campaign_recipients"("status");
CREATE UNIQUE INDEX IF NOT EXISTS "campaign_recipients_campaignId_customerId_key"
  ON "campaign_recipients"("campaignId", "customerId");
