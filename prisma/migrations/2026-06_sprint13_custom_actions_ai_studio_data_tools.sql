-- Sprint 13 — Custom Actions + AI Studio + Data Tools (additive)
-- All IF NOT EXISTS so re-runs are safe.

-- ── Custom Actions: no-code parameterized action recipes ──────────────────
CREATE TABLE IF NOT EXISTS action_recipes (
  id TEXT PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,                 -- webhook_out | compute_field | conditional_update
  config TEXT NOT NULL,               -- JSON per type
  enabled BOOLEAN NOT NULL DEFAULT true,
  "createdBy" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS action_recipes_company_idx ON action_recipes("companyId");

-- ── AI Studio: per-company AI personality/context ─────────────────────────
CREATE TABLE IF NOT EXISTS company_ai_profiles (
  id TEXT PRIMARY KEY,
  "companyId" TEXT NOT NULL UNIQUE,
  tone TEXT,                          -- formal | friendly | concise
  "businessContext" TEXT,             -- free text (≤2000 chars)
  "preferredLanguage" TEXT,           -- default AI output language override
  "customInstructions" TEXT,          -- ≤1000 chars, sanitized
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── AI Studio: saved scheduled AI-prompt reports ──────────────────────────
CREATE TABLE IF NOT EXISTS saved_ai_reports (
  id TEXT PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule TEXT NOT NULL DEFAULT 'weekly',   -- daily | weekly | manual
  recipients TEXT,                    -- JSON emails
  "lastRunAt" TIMESTAMPTZ,
  "lastResult" TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  "createdBy" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saved_ai_reports_company_idx ON saved_ai_reports("companyId");

-- ── Data Tools: merge + cleanup audit/undo log ────────────────────────────
CREATE TABLE IF NOT EXISTS merge_logs (
  id TEXT PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'merge', -- merge | cleanup
  "keptContactId" TEXT,
  "mergedContactId" TEXT,
  snapshot TEXT NOT NULL,             -- JSON pre-state + moved-ref counts
  undone BOOLEAN NOT NULL DEFAULT false,
  "userId" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS merge_logs_company_idx ON merge_logs("companyId", "createdAt");

-- ── Customer soft-delete marker (merge target) ────────────────────────────
ALTER TABLE customers ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS "mergedIntoId" TEXT;
