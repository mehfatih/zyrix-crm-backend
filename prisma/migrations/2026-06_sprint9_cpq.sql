-- Sprint 9 — CPQ: Quote Builder Pro
-- ADDITIVE ONLY. Safe to re-run (IF NOT EXISTS everywhere).
-- Apply in Railway → Data → SQL console (batch), and locally via
--   npx prisma db execute --file prisma/migrations/2026-06_sprint9_cpq.sql --schema prisma/schema.prisma
-- then `npx prisma generate`. Do NOT run prisma migrate/db push.

-- ── Price books ─────────────────────────────────────────────────────────────
-- A named set of per-product prices in one currency. `segmentRules` (JSON) lets
-- a book auto-pick for a customer by tags/countries; `isDefault` is the fallback.
CREATE TABLE IF NOT EXISTS price_books (
  id TEXT PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'TRY',
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "segmentRules" TEXT,                 -- JSON optional: {tags[], countries[]} auto-pick
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_price_books_company ON price_books("companyId");

-- One price per (book, product). Fallback when a product is absent = product.price.
CREATE TABLE IF NOT EXISTS price_book_entries (
  id TEXT PRIMARY KEY,
  "priceBookId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  price NUMERIC(14,2) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_price_book_entries_book_product ON price_book_entries("priceBookId", "productId");

-- ── Discount governance rules ───────────────────────────────────────────────
-- Per role or per user: up to maxPct applies freely; above maxPct and ≤
-- approvalAbovePct needs approval; above approvalAbovePct is blocked.
CREATE TABLE IF NOT EXISTS discount_rules (
  id TEXT PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'role',  -- role | user
  "scopeValue" TEXT NOT NULL,          -- role name or userId
  "maxPct" NUMERIC(5,2) NOT NULL,      -- can apply freely up to this
  "approvalAbovePct" NUMERIC(5,2)      -- above maxPct and ≤ this → needs approval; above this → blocked
);
CREATE INDEX IF NOT EXISTS idx_discount_rules_company ON discount_rules("companyId");

-- ── Bundles ─────────────────────────────────────────────────────────────────
-- A fixed-price grouping of products; expands to one grouped quote line.
CREATE TABLE IF NOT EXISTS bundles (
  id TEXT PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  name TEXT NOT NULL,
  items TEXT NOT NULL,                 -- JSON [{productId, qty}]
  "bundlePrice" NUMERIC(14,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' -- active | archived
);
CREATE INDEX IF NOT EXISTS idx_bundles_company ON bundles("companyId");

-- ── Quote tracking events ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quote_events (
  id TEXT PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  "quoteId" TEXT NOT NULL,
  type TEXT NOT NULL,                  -- sent | viewed | accepted | rejected | approval_requested | approved
  meta TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_quote_events_quote ON quote_events("quoteId", "createdAt");
CREATE INDEX IF NOT EXISTS idx_quote_events_company ON quote_events("companyId", "createdAt");

-- ── Quote extensions ────────────────────────────────────────────────────────
-- publicToken / viewedAt / acceptedAt already exist (pre-Sprint-9). Only the
-- CPQ governance + price-book columns are new.
ALTER TABLE "quotes" ADD COLUMN IF NOT EXISTS "priceBookId" TEXT;
ALTER TABLE "quotes" ADD COLUMN IF NOT EXISTS "approvalStatus" TEXT NOT NULL DEFAULT 'none'; -- none | pending | approved | rejected
ALTER TABLE "quotes" ADD COLUMN IF NOT EXISTS "approvedBy" TEXT;
