-- ============================================================================
-- Sprint 26 Phase 2 — Structured shipping address on customers
-- ----------------------------------------------------------------------------
-- Additive + idempotent. Safe to run multiple times. NO data loss: existing
-- "address"/"city"/"country" columns are untouched by this DDL. Going forward
-- the mapping stores the RAW street line 1 in "address" (it previously held a
-- "line1, city, country" concatenation); these four columns hold the rest of
-- the structured address used for fulfillment.
-- ============================================================================

ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "address2" TEXT;
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "postalCode" TEXT;
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "province" TEXT;
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "shippingPhone" TEXT;
