-- Sprint 10 — Email Intelligence
-- ADDITIVE ONLY. Safe to re-run (IF NOT EXISTS everywhere).
-- Apply in Railway → Data → SQL console (batch), and locally via
--   npx prisma db execute --file prisma/migrations/2026-06_sprint10_email_intel.sql --schema prisma/schema.prisma
-- then `npx prisma generate`. Do NOT run prisma migrate/db push.

-- ── Tracked CRM email messages (user → contact) ─────────────────────────────
-- System/auth/support emails are NEVER recorded here (they bypass the tracked
-- send path entirely). `trackToken` keys the open pixel + click links;
-- `providerId` (Resend message id) keys delivered/bounced webhook events.
CREATE TABLE IF NOT EXISTS email_messages (
  id TEXT PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  "contactId" TEXT,
  "userId" TEXT,                          -- sender (CRM user)
  direction TEXT NOT NULL DEFAULT 'out',  -- out | in
  subject TEXT,
  "bodyPreview" TEXT,                     -- first ~300 chars
  "providerId" TEXT,                      -- Resend message id
  "trackToken" TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'sent',    -- sent | delivered | bounced
  "sentAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_messages_contact ON email_messages("companyId", "contactId", "sentAt");
CREATE INDEX IF NOT EXISTS idx_email_messages_provider ON email_messages("providerId");

-- ── Per-message events (open / click / bounce / reply / complaint) ──────────
CREATE TABLE IF NOT EXISTS email_events (
  id TEXT PRIMARY KEY,
  "emailId" TEXT NOT NULL,
  type TEXT NOT NULL,                     -- open | click | bounce | reply | complaint
  meta TEXT,                              -- JSON {url?, ua?, ipHash?}
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_events_email ON email_events("emailId", type);

-- ── AI analysis of inbound replies (populated only once Resend Inbound is set
--    up — deferred this sprint; table created for forward-compat) ────────────
CREATE TABLE IF NOT EXISTS email_ai_analyses (
  id TEXT PRIMARY KEY,
  "emailId" TEXT NOT NULL UNIQUE,
  sentiment TEXT,                         -- positive | neutral | negative
  intent TEXT,                            -- interested | hesitant | objection | not_interested | question
  summary TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Privacy toggle (default ON) ─────────────────────────────────────────────
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "emailTrackingEnabled" BOOLEAN NOT NULL DEFAULT true;
