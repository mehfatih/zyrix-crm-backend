-- ============================================================================
-- ZYRIX CRM — Sprint 3: Messenger + Instagram DM → unified inbox
-- Run in Railway → Data tab → Query (idempotent — IF NOT EXISTS).
-- ----------------------------------------------------------------------------
-- ADDITIVE. The conversations/messages tables (Sprint 1) are already
-- channel-generic and need NO change — messenger/instagram are just new
-- `channel` values. The ONLY new structure is a contact channel-identity map:
-- DMs carry no phone/email, so a contact is matched by its platform-scoped
-- sender id (PSID for Messenger, IGSID for Instagram).
-- ============================================================================

-- ──────────────────────────────────────────────────────────────────────
-- contact_channel_identities — maps a platform-scoped sender id to a CRM
-- contact (customers.id). One row per (company, channel, externalId).
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "contact_channel_identities" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "companyId"   TEXT NOT NULL,
  "contactId"   TEXT NOT NULL,
  "channel"     TEXT NOT NULL,                 -- messenger | instagram | whatsapp
  "externalId"  TEXT NOT NULL,                 -- PSID | IGSID | (future) wa_id
  "profileName" TEXT,
  "createdAt"   TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"   TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "contact_channel_identities_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE,
  CONSTRAINT "contact_channel_identities_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "customers"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "contact_channel_identities_companyId_channel_externalId_key"
  ON "contact_channel_identities"("companyId", "channel", "externalId");
CREATE INDEX IF NOT EXISTS "contact_channel_identities_companyId_idx"
  ON "contact_channel_identities"("companyId");
CREATE INDEX IF NOT EXISTS "contact_channel_identities_contactId_idx"
  ON "contact_channel_identities"("contactId");

-- ============================================================================
-- Verify:
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema='public' AND table_name = 'contact_channel_identities';
-- Expected: 1 row
-- ============================================================================
