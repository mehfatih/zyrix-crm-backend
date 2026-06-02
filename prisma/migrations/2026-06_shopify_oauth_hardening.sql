-- ============================================================================
-- ZYRIX CRM — Shopify OAuth + Integration Health hardening
-- Sprint: SPRINT_Shopify_OAuth_UX_ErrorHardening
-- Run in Railway → Data tab → Query (idempotent — all IF NOT EXISTS).
-- ----------------------------------------------------------------------------
-- ADDITIVE ONLY. Does NOT touch ecommerce_stores / oauth_states (legacy
-- manual-token + /api/oauth path keep working). Safe to run multiple times.
-- ============================================================================

-- ──────────────────────────────────────────────────────────────────────
-- shopify_connections — one active record per (company, shop_domain).
-- Tokens are AES-256-GCM encrypted at rest (ciphertext/iv/tag triplets);
-- raw token values are NEVER stored. status drives the reconnect UX.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "shopify_connections" (
  "id"                        TEXT PRIMARY KEY NOT NULL,
  "companyId"                 TEXT NOT NULL,
  "shopDomain"                TEXT NOT NULL,
  -- pending | connected | needs_reauth | revoked | error
  "status"                    TEXT NOT NULL DEFAULT 'pending',

  -- Encrypted offline access token (AES-256-GCM)
  "accessTokenCiphertext"     TEXT,
  "accessTokenIv"             TEXT,
  "accessTokenTag"            TEXT,
  -- Encrypted refresh token (expiring offline tokens; may be null for the
  -- legacy non-expiring grant during migration)
  "refreshTokenCiphertext"    TEXT,
  "refreshTokenIv"            TEXT,
  "refreshTokenTag"           TEXT,

  "tokenExpiresAt"            TIMESTAMP,
  "refreshTokenExpiresAt"     TIMESTAMP,
  "scopes"                    TEXT,

  "lastSyncAt"                TIMESTAMP,
  "lastSyncDurationMs"        INTEGER,
  "lastError"                 TEXT,

  -- Link back to the ecommerce_stores row that powers the existing sync
  -- engine + dashboards (nullable; set after the first successful connect).
  "ecommerceStoreId"         TEXT,

  "createdAt"                 TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"                 TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "shopify_connections_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "shopify_connections_companyId_shopDomain_key"
  ON "shopify_connections"("companyId", "shopDomain");
CREATE INDEX IF NOT EXISTS "shopify_connections_companyId_idx"
  ON "shopify_connections"("companyId");
CREATE INDEX IF NOT EXISTS "shopify_connections_status_idx"
  ON "shopify_connections"("status");
CREATE INDEX IF NOT EXISTS "shopify_connections_tokenExpiresAt_idx"
  ON "shopify_connections"("tokenExpiresAt");

-- ──────────────────────────────────────────────────────────────────────
-- integration_events — centralized health/audit log for integrations.
-- One row per meaningful lifecycle event. NEVER stores secrets/tokens.
-- requestContext is jsonb { route, shop, userId, companyId, requestId }.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "integration_events" (
  "id"             TEXT PRIMARY KEY NOT NULL,
  "companyId"      TEXT,
  "platform"       TEXT NOT NULL DEFAULT 'shopify',
  -- oauth_start | oauth_success | oauth_failure | token_refresh |
  -- token_refresh_failure | sync_start | sync_success | sync_failure |
  -- disconnect | api_failure
  "eventType"      TEXT NOT NULL,
  "errorCode"      TEXT,
  "errorMessage"   TEXT,
  "requestContext" JSONB NOT NULL DEFAULT '{}',
  "durationMs"     INTEGER,
  "createdAt"      TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "integration_events_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "integration_events_companyId_idx"
  ON "integration_events"("companyId");
CREATE INDEX IF NOT EXISTS "integration_events_platform_idx"
  ON "integration_events"("platform");
CREATE INDEX IF NOT EXISTS "integration_events_eventType_idx"
  ON "integration_events"("eventType");
CREATE INDEX IF NOT EXISTS "integration_events_createdAt_idx"
  ON "integration_events"("createdAt");

-- ============================================================================
-- Done. Verify with:
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public'
--   AND table_name IN ('shopify_connections', 'integration_events');
-- Expected: 2 rows
-- ============================================================================
