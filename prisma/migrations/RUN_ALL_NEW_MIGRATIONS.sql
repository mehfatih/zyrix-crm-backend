-- ============================================================================
-- ZYRIX CRM — Consolidated migrations for features #8-#16
-- Run this whole file in Railway → Data tab → Query if migrations didn't auto-apply
-- Safe to run multiple times (all use IF NOT EXISTS)
-- ============================================================================

-- ──────────────────────────────────────────────────────────────────────
-- Feature #8: Commission Engine
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "commission_rules" (
  "id"             TEXT PRIMARY KEY NOT NULL,
  "companyId"      TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "description"    TEXT,
  "type"           TEXT NOT NULL DEFAULT 'percent',
  "config"         JSONB NOT NULL,
  "appliesTo"      TEXT NOT NULL DEFAULT 'all',
  "appliesToValue" TEXT,
  "isActive"       BOOLEAN NOT NULL DEFAULT true,
  "priority"       INTEGER NOT NULL DEFAULT 0,
  "createdAt"      TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"      TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT "commission_rules_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "commission_rules_companyId_idx" ON "commission_rules"("companyId");
CREATE INDEX IF NOT EXISTS "commission_rules_isActive_idx" ON "commission_rules"("isActive");
CREATE INDEX IF NOT EXISTS "commission_rules_priority_idx" ON "commission_rules"("priority");

CREATE TABLE IF NOT EXISTS "commission_entries" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "companyId"   TEXT NOT NULL,
  "ruleId"      TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "dealId"      TEXT NOT NULL,
  "baseValue"   DECIMAL(12,2) NOT NULL DEFAULT 0,
  "rate"        DECIMAL(8,4)  NOT NULL DEFAULT 0,
  "amount"      DECIMAL(12,2) NOT NULL DEFAULT 0,
  "currency"    TEXT NOT NULL DEFAULT 'TRY',
  "status"      TEXT NOT NULL DEFAULT 'pending',
  "approvedAt"  TIMESTAMP,
  "paidAt"      TIMESTAMP,
  "notes"       TEXT,
  "createdAt"   TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"   TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT "commission_entries_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE,
  CONSTRAINT "commission_entries_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "commission_rules"("id") ON DELETE CASCADE,
  CONSTRAINT "commission_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "commission_entries_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "deals"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "commission_entries_companyId_idx" ON "commission_entries"("companyId");
CREATE INDEX IF NOT EXISTS "commission_entries_userId_idx" ON "commission_entries"("userId");
CREATE INDEX IF NOT EXISTS "commission_entries_dealId_idx" ON "commission_entries"("dealId");
CREATE INDEX IF NOT EXISTS "commission_entries_ruleId_idx" ON "commission_entries"("ruleId");
CREATE INDEX IF NOT EXISTS "commission_entries_status_idx" ON "commission_entries"("status");
CREATE UNIQUE INDEX IF NOT EXISTS "commission_entries_dealId_ruleId_userId_key" ON "commission_entries"("dealId", "ruleId", "userId");

-- ──────────────────────────────────────────────────────────────────────
-- Feature #9+10: Campaigns (Marketing + Email Marketing)
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "campaigns" (
  "id"           TEXT PRIMARY KEY NOT NULL,
  "companyId"    TEXT NOT NULL,
  "createdById"  TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "subject"      TEXT,
  "channel"      TEXT NOT NULL DEFAULT 'email',
  "status"       TEXT NOT NULL DEFAULT 'draft',
  "bodyHtml"     TEXT,
  "bodyText"     TEXT,
  "fromName"     TEXT,
  "fromEmail"    TEXT,
  "replyTo"      TEXT,
  "targetType"   TEXT NOT NULL DEFAULT 'all',
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
CREATE INDEX IF NOT EXISTS "campaigns_companyId_idx" ON "campaigns"("companyId");
CREATE INDEX IF NOT EXISTS "campaigns_status_idx" ON "campaigns"("status");
CREATE INDEX IF NOT EXISTS "campaigns_channel_idx" ON "campaigns"("channel");
CREATE INDEX IF NOT EXISTS "campaigns_scheduledAt_idx" ON "campaigns"("scheduledAt");

CREATE TABLE IF NOT EXISTS "campaign_recipients" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "campaignId"  TEXT NOT NULL,
  "customerId"  TEXT NOT NULL,
  "email"       TEXT,
  "phone"       TEXT,
  "status"      TEXT NOT NULL DEFAULT 'queued',
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
CREATE INDEX IF NOT EXISTS "campaign_recipients_status_idx" ON "campaign_recipients"("status");
CREATE UNIQUE INDEX IF NOT EXISTS "campaign_recipients_campaignId_customerId_key" ON "campaign_recipients"("campaignId", "customerId");

-- ──────────────────────────────────────────────────────────────────────
-- Feature #11: Contract Management
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "contracts" (
  "id"             TEXT PRIMARY KEY NOT NULL,
  "companyId"      TEXT NOT NULL,
  "customerId"     TEXT NOT NULL,
  "dealId"         TEXT,
  "createdById"    TEXT NOT NULL,
  "contractNumber" TEXT NOT NULL,
  "title"          TEXT NOT NULL,
  "description"    TEXT,
  "status"         TEXT NOT NULL DEFAULT 'draft',
  "startDate"      TIMESTAMP,
  "endDate"        TIMESTAMP,
  "renewalDate"    TIMESTAMP,
  "signedAt"       TIMESTAMP,
  "value"          DECIMAL(12,2) NOT NULL DEFAULT 0,
  "currency"       TEXT NOT NULL DEFAULT 'TRY',
  "fileUrl"        TEXT,
  "fileName"       TEXT,
  "notes"          TEXT,
  "terms"          TEXT,
  "reminderSent"   BOOLEAN NOT NULL DEFAULT false,
  "createdAt"      TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"      TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT "contracts_companyId_fkey"    FOREIGN KEY ("companyId")    REFERENCES "companies"("id") ON DELETE CASCADE,
  CONSTRAINT "contracts_customerId_fkey"   FOREIGN KEY ("customerId")   REFERENCES "customers"("id") ON DELETE CASCADE,
  CONSTRAINT "contracts_dealId_fkey"       FOREIGN KEY ("dealId")       REFERENCES "deals"("id")     ON DELETE SET NULL,
  CONSTRAINT "contracts_createdById_fkey"  FOREIGN KEY ("createdById")  REFERENCES "users"("id")     ON DELETE NO ACTION
);
CREATE INDEX IF NOT EXISTS "contracts_companyId_idx" ON "contracts"("companyId");
CREATE INDEX IF NOT EXISTS "contracts_customerId_idx" ON "contracts"("customerId");
CREATE INDEX IF NOT EXISTS "contracts_dealId_idx" ON "contracts"("dealId");
CREATE INDEX IF NOT EXISTS "contracts_status_idx" ON "contracts"("status");
CREATE INDEX IF NOT EXISTS "contracts_endDate_idx" ON "contracts"("endDate");
CREATE INDEX IF NOT EXISTS "contracts_renewalDate_idx" ON "contracts"("renewalDate");
CREATE UNIQUE INDEX IF NOT EXISTS "contracts_companyId_contractNumber_key" ON "contracts"("companyId", "contractNumber");

-- ──────────────────────────────────────────────────────────────────────
-- Feature #12: Customer Portal
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "portal_tokens" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "customerId"  TEXT NOT NULL,
  "companyId"   TEXT NOT NULL,
  "token"       TEXT NOT NULL,
  "purpose"     TEXT NOT NULL DEFAULT 'login',
  "expiresAt"   TIMESTAMP NOT NULL,
  "usedAt"      TIMESTAMP,
  "ipAddress"   TEXT,
  "userAgent"   TEXT,
  "createdAt"   TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT "portal_tokens_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE,
  CONSTRAINT "portal_tokens_companyId_fkey"  FOREIGN KEY ("companyId")  REFERENCES "companies"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "portal_tokens_token_key" ON "portal_tokens"("token");
CREATE INDEX IF NOT EXISTS "portal_tokens_customerId_idx" ON "portal_tokens"("customerId");
CREATE INDEX IF NOT EXISTS "portal_tokens_companyId_idx" ON "portal_tokens"("companyId");
CREATE INDEX IF NOT EXISTS "portal_tokens_expiresAt_idx" ON "portal_tokens"("expiresAt");

-- ──────────────────────────────────────────────────────────────────────
-- Feature #13: Internal Chat
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "chat_messages" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "companyId"   TEXT NOT NULL,
  "fromUserId"  TEXT NOT NULL,
  "toUserId"    TEXT NOT NULL,
  "content"     TEXT NOT NULL,
  "readAt"      TIMESTAMP,
  "createdAt"   TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT "chat_messages_companyId_fkey"  FOREIGN KEY ("companyId")  REFERENCES "companies"("id") ON DELETE CASCADE,
  CONSTRAINT "chat_messages_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "users"("id")     ON DELETE CASCADE,
  CONSTRAINT "chat_messages_toUserId_fkey"   FOREIGN KEY ("toUserId")   REFERENCES "users"("id")     ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "chat_messages_companyId_idx" ON "chat_messages"("companyId");
CREATE INDEX IF NOT EXISTS "chat_messages_fromUserId_idx" ON "chat_messages"("fromUserId");
CREATE INDEX IF NOT EXISTS "chat_messages_toUserId_idx" ON "chat_messages"("toUserId");
CREATE INDEX IF NOT EXISTS "chat_messages_createdAt_idx" ON "chat_messages"("createdAt");
CREATE INDEX IF NOT EXISTS "chat_messages_readAt_idx" ON "chat_messages"("readAt");

-- ──────────────────────────────────────────────────────────────────────
-- Feature #16: Exchange Rates (Multi-Currency Reports)
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "exchange_rates" (
  "id"           TEXT PRIMARY KEY NOT NULL,
  "companyId"    TEXT NOT NULL,
  "fromCurrency" TEXT NOT NULL,
  "toCurrency"   TEXT NOT NULL,
  "rate"         DECIMAL(14,6) NOT NULL,
  "effectiveAt"  TIMESTAMP NOT NULL DEFAULT NOW(),
  "createdAt"    TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"    TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT "exchange_rates_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "exchange_rates_companyId_idx" ON "exchange_rates"("companyId");
CREATE INDEX IF NOT EXISTS "exchange_rates_fromCurrency_idx" ON "exchange_rates"("fromCurrency");
CREATE INDEX IF NOT EXISTS "exchange_rates_toCurrency_idx" ON "exchange_rates"("toCurrency");
CREATE UNIQUE INDEX IF NOT EXISTS "exchange_rates_companyId_fromCurrency_toCurrency_key" ON "exchange_rates"("companyId", "fromCurrency", "toCurrency");

-- ============================================================================
-- Done. Verify with:
--   SELECT table_name FROM information_schema.tables 
--   WHERE table_schema = 'public' 
--   AND table_name IN ('commission_rules', 'commission_entries', 'campaigns', 
--                      'campaign_recipients', 'contracts', 'portal_tokens', 
--                      'chat_messages', 'exchange_rates');
-- Expected: 8 rows
-- ============================================================================
