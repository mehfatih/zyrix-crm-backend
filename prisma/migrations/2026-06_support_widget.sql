-- ============================================================================
-- ZYRIX CRM — Sprint 4: AI-First Support Widget (live chat + handoff + survey)
-- Run in Railway → Data tab → Query (idempotent — IF NOT EXISTS).
-- ----------------------------------------------------------------------------
-- ADDITIVE. Brand-new support_* tables for the AI support chat. Does NOT touch
-- the existing support_tickets system (separate async ticket queue).
-- ============================================================================

-- ──────────────────────────────────────────────────────────────────────
-- support_conversations — one AI support chat thread per merchant session.
-- State machine: open_ai → awaiting_human → human → closed.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "support_conversations" (
  "id"              TEXT PRIMARY KEY NOT NULL,
  "companyId"       TEXT NOT NULL,
  "userId"          TEXT,                              -- merchant user who opened it
  "status"          TEXT NOT NULL DEFAULT 'open_ai',   -- open_ai | awaiting_human | human | closed
  "contactEmail"    TEXT,
  "transcriptOptIn" BOOLEAN NOT NULL DEFAULT FALSE,
  "assignedAdminId" TEXT,                              -- super-admin who claimed it
  "subject"         TEXT,                              -- AI-derived, optional
  "escalatedAt"     TIMESTAMP,
  "fallbackSentAt"  TIMESTAMP,                         -- email-fallback dedupe
  "createdAt"       TIMESTAMP NOT NULL DEFAULT NOW(),
  "lastMessageAt"   TIMESTAMP,
  "closedAt"        TIMESTAMP,

  CONSTRAINT "support_conversations_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE,
  CONSTRAINT "support_conversations_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "support_conversations_companyId_idx" ON "support_conversations"("companyId");
CREATE INDEX IF NOT EXISTS "support_conversations_status_idx" ON "support_conversations"("status");
CREATE INDEX IF NOT EXISTS "support_conversations_lastMessageAt_idx" ON "support_conversations"("lastMessageAt");

-- ──────────────────────────────────────────────────────────────────────
-- support_messages — one row per turn. sender = user | ai | human | system.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "support_messages" (
  "id"             TEXT PRIMARY KEY NOT NULL,
  "conversationId" TEXT NOT NULL,
  "sender"         TEXT NOT NULL,                      -- user | ai | human | system
  "body"           TEXT NOT NULL,
  "createdAt"      TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "support_messages_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "support_conversations"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "support_messages_conversationId_idx" ON "support_messages"("conversationId");
CREATE INDEX IF NOT EXISTS "support_messages_createdAt_idx" ON "support_messages"("createdAt");

-- ──────────────────────────────────────────────────────────────────────
-- support_surveys — tap-only end-of-chat survey (3 × 1–5, no free text).
-- One row per conversation.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "support_surveys" (
  "id"             TEXT PRIMARY KEY NOT NULL,
  "conversationId" TEXT NOT NULL,
  "qQuality"       INTEGER,                            -- 1..5
  "qService"       INTEGER,                            -- 1..5
  "qResolvedFast"  INTEGER,                            -- 1..5
  "createdAt"      TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "support_surveys_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "support_conversations"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "support_surveys_conversationId_key"
  ON "support_surveys"("conversationId");

-- ============================================================================
-- Verify:
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema='public'
--     AND table_name IN ('support_conversations','support_messages','support_surveys');
-- Expected: 3 rows
-- ============================================================================
