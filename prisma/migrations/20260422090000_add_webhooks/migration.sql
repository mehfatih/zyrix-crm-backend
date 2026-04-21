-- ============================================================================
-- Webhooks — inbound subscriptions + event log for Shopify/Salla/Zid/etc.
-- ============================================================================

-- ─── webhook_subscriptions ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "webhook_subscriptions" (
  "id"         TEXT PRIMARY KEY NOT NULL,
  "companyId"  TEXT NOT NULL,
  "storeId"    TEXT,
  "platform"   TEXT NOT NULL,
  "topic"      TEXT NOT NULL,
  "secret"     TEXT NOT NULL,
  "isActive"   BOOLEAN NOT NULL DEFAULT true,

  "lastReceivedAt" TIMESTAMP(3),
  "receivedCount"  INTEGER NOT NULL DEFAULT 0,
  "failedCount"    INTEGER NOT NULL DEFAULT 0,

  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "webhook_subscriptions_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "webhook_subscriptions_unique_topic"
  ON "webhook_subscriptions" ("companyId", "platform", "storeId", "topic");

CREATE INDEX IF NOT EXISTS "webhook_subscriptions_companyId_idx"
  ON "webhook_subscriptions" ("companyId");

CREATE INDEX IF NOT EXISTS "webhook_subscriptions_platform_idx"
  ON "webhook_subscriptions" ("platform");

CREATE INDEX IF NOT EXISTS "webhook_subscriptions_storeId_idx"
  ON "webhook_subscriptions" ("storeId");

-- ─── webhook_events ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "webhook_events" (
  "id"              TEXT PRIMARY KEY NOT NULL,
  "companyId"       TEXT NOT NULL,
  "subscriptionId"  TEXT,
  "platform"        TEXT NOT NULL,
  "topic"           TEXT NOT NULL,
  "externalId"      TEXT,

  "status"    TEXT NOT NULL DEFAULT 'pending',
  "attempts"  INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,

  "payloadRaw"  TEXT NOT NULL,
  "payloadJson" JSONB NOT NULL DEFAULT '{}',

  "signatureOk" BOOLEAN NOT NULL DEFAULT true,
  "receivedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),

  CONSTRAINT "webhook_events_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE,
  CONSTRAINT "webhook_events_subscriptionId_fkey"
    FOREIGN KEY ("subscriptionId") REFERENCES "webhook_subscriptions"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "webhook_events_companyId_idx"
  ON "webhook_events" ("companyId");

CREATE INDEX IF NOT EXISTS "webhook_events_platform_topic_idx"
  ON "webhook_events" ("platform", "topic");

CREATE INDEX IF NOT EXISTS "webhook_events_status_idx"
  ON "webhook_events" ("status");

CREATE INDEX IF NOT EXISTS "webhook_events_receivedAt_idx"
  ON "webhook_events" ("receivedAt");
