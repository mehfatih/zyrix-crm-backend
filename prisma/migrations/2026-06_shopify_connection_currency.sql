-- Sprint 8 follow-up — per-store Shopify currency
-- ADDITIVE, idempotent. Apply via:
--   npx prisma db execute --file prisma/migrations/2026-06_shopify_connection_currency.sql --schema prisma/schema.prisma
-- (DATABASE_URL points at Railway, so this applies to prod.) Then prisma generate.
--
-- Stores each connected store's currency (from Shopify shop.json) so bridged
-- catalog products are stamped with the real currency instead of the products
-- table's TRY default. Per-connection → a company can connect multiple stores
-- with different currencies (e.g. an SAR store and a TR store).
ALTER TABLE "shopify_connections" ADD COLUMN IF NOT EXISTS "currency" TEXT;
