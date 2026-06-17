-- CAC Sprint 3 (Phase 2) — Live web-research ENRICHMENT cache (raw SQL, shared).
-- Additive + idempotent (CREATE TABLE / INDEX IF NOT EXISTS). Raw-SQL table (NO
-- Prisma model, accessed via $queryRawUnsafe — mirrors Sprint 18/19/20/24 + CAC
-- Phase 1/2 convention). NO `prisma db push`/`generate`, NO schema.prisma change
-- → backend tsc 11-baseline untouched.
--
-- APPLY ON RAILWAY via:  npx prisma db execute --file prisma/migrations/20260617130000_cac_sprint3_research_cache/migration.sql --schema prisma/schema.prisma
-- (Mehmet applies this. Claude never runs db push against prod.)
--
-- WHAT THIS IS (locked scope): a server-side cache of LIVE web-research ENRICHMENT
-- — real, dated case-studies/examples that decorate the existing rule-based CAC
-- recommendations. It is ENRICHMENT ONLY:
--   • The static sourced benchmarks (cac-benchmarks.ts) + the rule-based
--     personalized levers (cac-forecast.service.ts) stay AUTHORITATIVE.
--   • NOTHING in this table EVER enters the forecast/benchmark/CAC math — it is
--     read as DISPLAY TEXT + citation links only. No authoritative number is ever
--     sourced from here (hallucination firewall).
--
-- KEYED BY INDUSTRY + TOPIC, NOT PER-TENANT (shared across all tenants of the same
-- industry band) so the weekly refresh makes ~15 Gemini calls total platform-wide,
-- not one-per-tenant:
--   • industryKey = the cac-benchmarks band key: 'beauty_skincare' | 'ecommerce_dtc' | 'general_dtc'
--   • topic       = a PLAYBOOK_LEVERS id: 'cro' | 'cart_recovery' | 'aov_upsell' | 'ab_testing' | 'owned_channels'
--   • locale      = 'en' only in v1 (translation is a later follow-up).
-- Cardinality ≈ 3 industries × 5 topics × 1 locale = 15 rows for the whole platform.
--
-- NEVER FETCHED ON PAGE LOAD: the recommendations read path does a PURE SELECT from
-- this table. The ONLY writer is the weekly cron worker (cac-research-worker), gated
-- behind CAC_RESEARCH_ENABLED (default OFF) + DISABLE_CAC_RESEARCH_CRON. Flag OFF →
-- worker never runs → table empty → /cac behavior byte-identical to Phase 1.
--
-- GROUNDING ToS (Gemini "Grounding with Google Search"): a grounded result must be
-- displayed WITH its associated Google Search Suggestions. We cache the Suggestions
-- HTML/CSS (searchEntryPoint.renderedContent) in "searchEntryPoint" at fetch time so
-- the page can render the chip (sandboxed) whenever it shows the enrichment.
--
-- ENTITLEMENT: read reuses the existing `cac` key (ALL_ON) — NO new plan_features
-- seed. The cron/live-calls are gated by CAC_RESEARCH_ENABLED (env), not entitlement.

-- ── cac_research_cache: shared enrichment cache, keyed industry × topic × locale ──
CREATE TABLE IF NOT EXISTS "cac_research_cache" (
  "id"               TEXT NOT NULL,
  "industryKey"      TEXT NOT NULL,                         -- benchmark band key (beauty_skincare|ecommerce_dtc|general_dtc)
  "topic"            TEXT NOT NULL,                         -- PLAYBOOK_LEVERS id (cro|cart_recovery|aov_upsell|ab_testing|owned_channels)
  "locale"           TEXT NOT NULL DEFAULT 'en',            -- 'en' only in v1
  "payload"          JSONB NOT NULL DEFAULT '[]',           -- citation items: [{title,summary,sourceUrl,sourceTitle,publishedDate,attribution}] (text+links ONLY)
  "searchEntryPoint" TEXT,                                  -- Google Search-Suggestions HTML/CSS (renderedContent) — rendered sandboxed alongside enrichment for ToS compliance; NULL when grounding returned none
  "model"            TEXT,                                  -- e.g. 'gemini-2.5-flash+google_search'
  "status"           TEXT NOT NULL DEFAULT 'ok',            -- 'ok' | 'stale' | 'error' (never blocks the page; read degrades to Phase-1)
  "fetchedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"        TIMESTAMP(3) NOT NULL,                 -- fetchedAt + grace window (> the weekly cron) so a skipped run never empties cache
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cac_research_cache_pkey" PRIMARY KEY ("id")
);

-- One cached row per (industry, topic, locale) — the cron UPSERTs on this key.
CREATE UNIQUE INDEX IF NOT EXISTS "cac_research_cache_key_uniq"
  ON "cac_research_cache"("industryKey","topic","locale");

-- Sweep helper for expiry/staleness checks.
CREATE INDEX IF NOT EXISTS "cac_research_cache_expiresAt_idx"
  ON "cac_research_cache"("expiresAt");
