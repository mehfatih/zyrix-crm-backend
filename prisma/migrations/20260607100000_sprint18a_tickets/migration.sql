-- ============================================================================
-- SPRINT 18 — PHASE A : SERVICE DESK CORE (Tickets)
-- Additive only. Idempotent (IF NOT EXISTS). Apply in Railway → Data → SQL.
-- ----------------------------------------------------------------------------
-- New tables: tickets, ticket_events, ticket_counters.
-- Plus: plan_features rows for the 3 new feature keys (service_desk,
-- service_sla, service_routing) so the admin god-mode matrix + per-plan
-- auto-activation pick them up (Sprint 16 system). Defaults mirror
-- FEATURE_CATALOG: service_desk = STARTER_UP, service_sla / service_routing
-- = BUSINESS_UP. limitValue NULL (all booleans).
-- NOTE: collides with neither the existing platform `support_tickets` table
-- (merchant→Zyrix support) nor the ENTERPRISE-only `sla` uptime feature key.
-- ============================================================================

-- ── tickets ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "tickets" (
  "id"                TEXT NOT NULL,
  "companyId"         TEXT NOT NULL,
  "number"            INTEGER NOT NULL,
  "customerId"        TEXT,
  "channel"           TEXT NOT NULL DEFAULT 'manual',
  "subject"           TEXT,
  "status"            TEXT NOT NULL DEFAULT 'new',
  "priority"          TEXT NOT NULL DEFAULT 'normal',
  "assigneeId"        TEXT,
  "conversationId"    TEXT,
  "emailMessageId"    TEXT,
  "firstResponseAt"   TIMESTAMP(3),
  "resolvedAt"        TIMESTAMP(3),
  "closedAt"          TIMESTAMP(3),
  "lastCustomerMsgAt" TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "tickets_companyId_number_key"
  ON "tickets" ("companyId", "number");
CREATE INDEX IF NOT EXISTS "tickets_companyId_status_idx"
  ON "tickets" ("companyId", "status");
CREATE INDEX IF NOT EXISTS "tickets_companyId_assigneeId_idx"
  ON "tickets" ("companyId", "assigneeId");
CREATE INDEX IF NOT EXISTS "tickets_companyId_customerId_channel_idx"
  ON "tickets" ("companyId", "customerId", "channel");
CREATE INDEX IF NOT EXISTS "tickets_conversationId_idx"
  ON "tickets" ("conversationId");

-- ── ticket_events (audit/status log; internal notes live in `comments`) ──────
CREATE TABLE IF NOT EXISTS "ticket_events" (
  "id"          TEXT NOT NULL,
  "ticketId"    TEXT NOT NULL,
  "companyId"   TEXT NOT NULL,
  "type"        TEXT NOT NULL,
  "actorUserId" TEXT,
  "fromValue"   TEXT,
  "toValue"     TEXT,
  "metadata"    JSONB NOT NULL DEFAULT '{}',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ticket_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ticket_events_ticketId_createdAt_idx"
  ON "ticket_events" ("ticketId", "createdAt");
CREATE INDEX IF NOT EXISTS "ticket_events_companyId_type_createdAt_idx"
  ON "ticket_events" ("companyId", "type", "createdAt");

-- ── ticket_counters (atomic per-company numbering) ───────────────────────────
CREATE TABLE IF NOT EXISTS "ticket_counters" (
  "companyId"  TEXT NOT NULL,
  "lastNumber" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "ticket_counters_pkey" PRIMARY KEY ("companyId")
);

-- ── service_desk_settings (one-click enable; INERT until enabled=true) ───────
-- Default enabled=false ⇒ no auto-create + no UX even for entitled (enterprise)
-- tenants until the merchant toggles ON. Phase B extends with the SLA preset.
CREATE TABLE IF NOT EXISTS "service_desk_settings" (
  "companyId"  TEXT NOT NULL,
  "enabled"    BOOLEAN NOT NULL DEFAULT false,
  "autoCreate" BOOLEAN NOT NULL DEFAULT true,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "service_desk_settings_pkey" PRIMARY KEY ("companyId")
);

-- ── plan_features rows for the 3 new keys (mirror FEATURE_CATALOG defaults) ──
-- service_desk  → STARTER_UP   (free off; starter/business/enterprise on)
-- service_sla   → BUSINESS_UP  (free/starter off; business/enterprise on)
-- service_routing → BUSINESS_UP
INSERT INTO "plan_features" ("id","plan","featureKey","enabled","limitValue","updatedAt","createdAt")
VALUES
  (gen_random_uuid()::text, 'free',       'service_desk',    false, NULL, NOW(), NOW()),
  (gen_random_uuid()::text, 'starter',    'service_desk',    true,  NULL, NOW(), NOW()),
  (gen_random_uuid()::text, 'business',   'service_desk',    true,  NULL, NOW(), NOW()),
  (gen_random_uuid()::text, 'enterprise', 'service_desk',    true,  NULL, NOW(), NOW()),
  (gen_random_uuid()::text, 'free',       'service_sla',     false, NULL, NOW(), NOW()),
  (gen_random_uuid()::text, 'starter',    'service_sla',     false, NULL, NOW(), NOW()),
  (gen_random_uuid()::text, 'business',   'service_sla',     true,  NULL, NOW(), NOW()),
  (gen_random_uuid()::text, 'enterprise', 'service_sla',     true,  NULL, NOW(), NOW()),
  (gen_random_uuid()::text, 'free',       'service_routing', false, NULL, NOW(), NOW()),
  (gen_random_uuid()::text, 'starter',    'service_routing', false, NULL, NOW(), NOW()),
  (gen_random_uuid()::text, 'business',   'service_routing', true,  NULL, NOW(), NOW()),
  (gen_random_uuid()::text, 'enterprise', 'service_routing', true,  NULL, NOW(), NOW())
ON CONFLICT ("plan","featureKey")
DO UPDATE SET "enabled" = EXCLUDED."enabled",
              "limitValue" = EXCLUDED."limitValue",
              "updatedAt" = NOW();
