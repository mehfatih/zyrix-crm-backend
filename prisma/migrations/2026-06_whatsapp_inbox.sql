-- ============================================================================
-- ZYRIX CRM — Unified Conversations/Inbox (WhatsApp first; Messenger/IG reuse)
-- Sprint 1: WhatsApp Business Cloud API
-- Run in Railway → Data tab → Query (idempotent — IF NOT EXISTS).
-- ----------------------------------------------------------------------------
-- ADDITIVE. Does NOT touch the legacy whatsapp_chats table.
-- ============================================================================

-- ──────────────────────────────────────────────────────────────────────
-- conversations — one thread per (company, channel, external thread).
-- Channel-generic so Messenger/Instagram (Sprint 3) reuse the same table.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "conversations" (
  "id"               TEXT PRIMARY KEY NOT NULL,
  "companyId"        TEXT NOT NULL,
  "channel"          TEXT NOT NULL DEFAULT 'whatsapp',  -- whatsapp | messenger | instagram
  "externalThreadId" TEXT NOT NULL,                     -- WhatsApp wa_id / phone, etc.
  "contactId"        TEXT,                              -- customers.id (matched/created)
  "dealId"           TEXT,                              -- optional pipeline attach
  "assignedUserId"   TEXT,
  "status"           TEXT NOT NULL DEFAULT 'open',      -- open | pending | closed
  "lastMessageAt"    TIMESTAMP,
  "windowExpiresAt"  TIMESTAMP,                         -- 24h service-reply window
  "lastInboundAt"    TIMESTAMP,
  "unreadCount"      INTEGER NOT NULL DEFAULT 0,
  "createdAt"        TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"        TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "conversations_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE,
  CONSTRAINT "conversations_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "customers"("id") ON DELETE SET NULL,
  CONSTRAINT "conversations_dealId_fkey"
    FOREIGN KEY ("dealId") REFERENCES "deals"("id") ON DELETE SET NULL,
  CONSTRAINT "conversations_assignedUserId_fkey"
    FOREIGN KEY ("assignedUserId") REFERENCES "users"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "conversations_companyId_channel_externalThreadId_key"
  ON "conversations"("companyId", "channel", "externalThreadId");
CREATE INDEX IF NOT EXISTS "conversations_companyId_idx" ON "conversations"("companyId");
CREATE INDEX IF NOT EXISTS "conversations_contactId_idx" ON "conversations"("contactId");
CREATE INDEX IF NOT EXISTS "conversations_dealId_idx" ON "conversations"("dealId");
CREATE INDEX IF NOT EXISTS "conversations_status_idx" ON "conversations"("status");
CREATE INDEX IF NOT EXISTS "conversations_lastMessageAt_idx" ON "conversations"("lastMessageAt");

-- ──────────────────────────────────────────────────────────────────────
-- messages — one row per message in a conversation.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "messages" (
  "id"                TEXT PRIMARY KEY NOT NULL,
  "conversationId"    TEXT NOT NULL,
  "companyId"         TEXT NOT NULL,                    -- denormalized for tenant-scoped queries
  "direction"         TEXT NOT NULL,                    -- in | out
  "externalMessageId" TEXT,                             -- Meta message id (wamid…)
  "type"              TEXT NOT NULL DEFAULT 'text',     -- text|image|document|audio|video|location|interactive|template
  "body"              TEXT,
  "mediaUrl"          TEXT,
  "status"            TEXT NOT NULL DEFAULT 'received',  -- received|sent|delivered|read|failed
  "errorDetail"       TEXT,
  "sentByUserId"      TEXT,                             -- who sent an outbound reply
  "sentAt"            TIMESTAMP,
  "createdAt"         TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "messages_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE,
  CONSTRAINT "messages_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "messages_externalMessageId_key"
  ON "messages"("externalMessageId") WHERE "externalMessageId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "messages_conversationId_idx" ON "messages"("conversationId");
CREATE INDEX IF NOT EXISTS "messages_companyId_idx" ON "messages"("companyId");
CREATE INDEX IF NOT EXISTS "messages_createdAt_idx" ON "messages"("createdAt");

-- ──────────────────────────────────────────────────────────────────────
-- whatsapp_numbers — maps a Meta phone_number_id to a Zyrix company so an
-- app-level webhook can be routed to the right tenant. A company "claims" the
-- configured number once (POST /connect). Unique per phone_number_id.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "whatsapp_numbers" (
  "id"            TEXT PRIMARY KEY NOT NULL,
  "companyId"     TEXT NOT NULL,
  "phoneNumberId" TEXT NOT NULL,
  "wabaId"        TEXT,
  "displayPhone"  TEXT,
  "status"        TEXT NOT NULL DEFAULT 'connected',  -- connected | revoked
  "createdAt"     TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"     TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "whatsapp_numbers_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_numbers_phoneNumberId_key"
  ON "whatsapp_numbers"("phoneNumberId");
CREATE INDEX IF NOT EXISTS "whatsapp_numbers_companyId_idx" ON "whatsapp_numbers"("companyId");

-- ============================================================================
-- Verify:
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema='public'
--     AND table_name IN ('conversations','messages','whatsapp_numbers');
-- Expected: 3 rows
-- ============================================================================
