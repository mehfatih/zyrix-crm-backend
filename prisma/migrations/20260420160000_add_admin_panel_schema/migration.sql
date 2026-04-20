-- ============================================================================
-- ZYRIX CRM — Admin Panel Migration
-- Adds: super_admin infrastructure, Plans, Subscriptions, AuditLog, etc.
-- ============================================================================

-- ──────────────────────────────────────────────────────────────────────────
-- ALTER: companies — add admin control + billing fields
-- ──────────────────────────────────────────────────────────────────────────
ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "status"         TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS "trialEndsAt"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "suspendedAt"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "suspendReason"  TEXT,
  ADD COLUMN IF NOT EXISTS "deletedAt"      TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "billingEmail"   TEXT,
  ADD COLUMN IF NOT EXISTS "country"        TEXT,
  ADD COLUMN IF NOT EXISTS "industry"       TEXT,
  ADD COLUMN IF NOT EXISTS "size"           TEXT;

CREATE INDEX IF NOT EXISTS "companies_status_idx" ON "companies"("status");
CREATE INDEX IF NOT EXISTS "companies_plan_idx"   ON "companies"("plan");

-- ──────────────────────────────────────────────────────────────────────────
-- ALTER: users — add disable/status fields
-- ──────────────────────────────────────────────────────────────────────────
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "status"         TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS "disabledAt"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "disabledReason" TEXT;

CREATE INDEX IF NOT EXISTS "users_role_idx"   ON "users"("role");
CREATE INDEX IF NOT EXISTS "users_status_idx" ON "users"("status");

-- ──────────────────────────────────────────────────────────────────────────
-- CREATE: plans
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "plans" (
  "id"              TEXT        NOT NULL,
  "slug"            TEXT        NOT NULL,
  "name"            TEXT        NOT NULL,
  "nameAr"          TEXT        NOT NULL,
  "nameTr"          TEXT        NOT NULL,
  "description"     TEXT,
  "descriptionAr"   TEXT,
  "descriptionTr"   TEXT,
  "priceMonthlyUsd" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "priceYearlyUsd"  DECIMAL(10,2) NOT NULL DEFAULT 0,
  "priceMonthlyTry" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "priceYearlyTry"  DECIMAL(10,2) NOT NULL DEFAULT 0,
  "priceMonthlySar" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "priceYearlySar"  DECIMAL(10,2) NOT NULL DEFAULT 0,
  "maxUsers"        INTEGER     NOT NULL DEFAULT 1,
  "maxCustomers"    INTEGER     NOT NULL DEFAULT 100,
  "maxDeals"        INTEGER     NOT NULL DEFAULT 100,
  "maxStorageGb"    INTEGER     NOT NULL DEFAULT 1,
  "maxWhatsappMsg"  INTEGER     NOT NULL DEFAULT 100,
  "maxAiTokens"     INTEGER     NOT NULL DEFAULT 10000,
  "features"        JSONB       NOT NULL DEFAULT '[]',
  "isActive"        BOOLEAN     NOT NULL DEFAULT true,
  "isFeatured"      BOOLEAN     NOT NULL DEFAULT false,
  "sortOrder"       INTEGER     NOT NULL DEFAULT 0,
  "color"           TEXT        NOT NULL DEFAULT '#0891B2',
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "plans_slug_key" ON "plans"("slug");

-- ──────────────────────────────────────────────────────────────────────────
-- CREATE: plan_overrides
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "plan_overrides" (
  "id"          TEXT        NOT NULL,
  "companyId"   TEXT        NOT NULL,
  "featureSlug" TEXT        NOT NULL,
  "enabled"     BOOLEAN     NOT NULL DEFAULT true,
  "expiresAt"   TIMESTAMP(3),
  "reason"      TEXT,
  "grantedBy"   TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "plan_overrides_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "plan_overrides_companyId_featureSlug_key" ON "plan_overrides"("companyId", "featureSlug");
CREATE INDEX IF NOT EXISTS "plan_overrides_companyId_idx"   ON "plan_overrides"("companyId");
CREATE INDEX IF NOT EXISTS "plan_overrides_featureSlug_idx" ON "plan_overrides"("featureSlug");

ALTER TABLE "plan_overrides"
  ADD CONSTRAINT "plan_overrides_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ──────────────────────────────────────────────────────────────────────────
-- CREATE: subscriptions
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "subscriptions" (
  "id"                 TEXT        NOT NULL,
  "companyId"          TEXT        NOT NULL,
  "planId"             TEXT        NOT NULL,
  "status"             TEXT        NOT NULL DEFAULT 'active',
  "billingCycle"       TEXT        NOT NULL DEFAULT 'monthly',
  "currency"           TEXT        NOT NULL DEFAULT 'USD',
  "amount"             DECIMAL(10,2) NOT NULL,
  "currentPeriodStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "currentPeriodEnd"   TIMESTAMP(3) NOT NULL,
  "cancelAt"           TIMESTAMP(3),
  "cancelledAt"        TIMESTAMP(3),
  "trialStart"         TIMESTAMP(3),
  "trialEnd"           TIMESTAMP(3),
  "gateway"            TEXT,
  "gatewayCustomerId"  TEXT,
  "gatewaySubId"       TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "subscriptions_companyId_idx" ON "subscriptions"("companyId");
CREATE INDEX IF NOT EXISTS "subscriptions_planId_idx"    ON "subscriptions"("planId");
CREATE INDEX IF NOT EXISTS "subscriptions_status_idx"    ON "subscriptions"("status");

ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "subscriptions_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ──────────────────────────────────────────────────────────────────────────
-- CREATE: payments
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "payments" (
  "id"               TEXT        NOT NULL,
  "companyId"        TEXT        NOT NULL,
  "subscriptionId"   TEXT,
  "amount"           DECIMAL(10,2) NOT NULL,
  "currency"         TEXT        NOT NULL DEFAULT 'USD',
  "status"           TEXT        NOT NULL DEFAULT 'pending',
  "gateway"          TEXT        NOT NULL,
  "gatewayPaymentId" TEXT,
  "gatewayReference" TEXT,
  "method"           TEXT,
  "last4"            TEXT,
  "cardBrand"        TEXT,
  "description"      TEXT,
  "failureReason"    TEXT,
  "metadata"         JSONB,
  "paidAt"           TIMESTAMP(3),
  "refundedAt"       TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "payments_companyId_idx"        ON "payments"("companyId");
CREATE INDEX IF NOT EXISTS "payments_subscriptionId_idx"   ON "payments"("subscriptionId");
CREATE INDEX IF NOT EXISTS "payments_status_idx"           ON "payments"("status");
CREATE INDEX IF NOT EXISTS "payments_gateway_idx"          ON "payments"("gateway");
CREATE INDEX IF NOT EXISTS "payments_gatewayPaymentId_idx" ON "payments"("gatewayPaymentId");

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "payments_subscriptionId_fkey"
  FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ──────────────────────────────────────────────────────────────────────────
-- CREATE: audit_logs
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id"         TEXT        NOT NULL,
  "userId"     TEXT,
  "companyId"  TEXT,
  "action"     TEXT        NOT NULL,
  "entityType" TEXT,
  "entityId"   TEXT,
  "changes"    JSONB,
  "metadata"   JSONB,
  "ipAddress"  TEXT,
  "userAgent"  TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "audit_logs_userId_idx"                ON "audit_logs"("userId");
CREATE INDEX IF NOT EXISTS "audit_logs_companyId_idx"             ON "audit_logs"("companyId");
CREATE INDEX IF NOT EXISTS "audit_logs_action_idx"                ON "audit_logs"("action");
CREATE INDEX IF NOT EXISTS "audit_logs_entityType_entityId_idx"   ON "audit_logs"("entityType", "entityId");
CREATE INDEX IF NOT EXISTS "audit_logs_createdAt_idx"             ON "audit_logs"("createdAt");

ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "audit_logs_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ──────────────────────────────────────────────────────────────────────────
-- CREATE: announcements
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "announcements" (
  "id"          TEXT        NOT NULL,
  "title"       TEXT        NOT NULL,
  "titleAr"     TEXT,
  "titleTr"     TEXT,
  "content"     TEXT        NOT NULL,
  "contentAr"   TEXT,
  "contentTr"   TEXT,
  "type"        TEXT        NOT NULL DEFAULT 'info',
  "target"      TEXT        NOT NULL DEFAULT 'all',
  "targetValue" TEXT,
  "startsAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endsAt"      TIMESTAMP(3),
  "isActive"    BOOLEAN     NOT NULL DEFAULT true,
  "createdBy"   TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "announcements_isActive_idx" ON "announcements"("isActive");
CREATE INDEX IF NOT EXISTS "announcements_target_idx"   ON "announcements"("target");

-- ──────────────────────────────────────────────────────────────────────────
-- CREATE: support_tickets
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "support_tickets" (
  "id"           TEXT        NOT NULL,
  "companyId"    TEXT        NOT NULL,
  "createdById"  TEXT        NOT NULL,
  "subject"      TEXT        NOT NULL,
  "description"  TEXT        NOT NULL,
  "category"     TEXT        NOT NULL DEFAULT 'general',
  "priority"     TEXT        NOT NULL DEFAULT 'medium',
  "status"       TEXT        NOT NULL DEFAULT 'open',
  "assignedToId" TEXT,
  "resolvedAt"   TIMESTAMP(3),
  "closedAt"     TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "support_tickets_companyId_idx"    ON "support_tickets"("companyId");
CREATE INDEX IF NOT EXISTS "support_tickets_status_idx"       ON "support_tickets"("status");
CREATE INDEX IF NOT EXISTS "support_tickets_priority_idx"     ON "support_tickets"("priority");
CREATE INDEX IF NOT EXISTS "support_tickets_assignedToId_idx" ON "support_tickets"("assignedToId");

ALTER TABLE "support_tickets"
  ADD CONSTRAINT "support_tickets_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "support_tickets_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "support_tickets_assignedToId_fkey"
  FOREIGN KEY ("assignedToId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
