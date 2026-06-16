-- Sprint 27 — Campaign start date + target country (Campaign Economics, Sprint 24 follow-up).
-- Additive + idempotent. Raw-SQL columns on the raw-SQL ad_campaigns table (NO Prisma
-- model; accessed via $queryRawUnsafe — same convention as Sprint 24A). Therefore NO
-- `prisma db push` / `prisma generate` is required: schema.prisma has no ad_campaigns model.
--
-- APPLY ON RAILWAY via (Mehmet runs this; Claude never runs db push against prod):
--   npx prisma db execute --file prisma/migrations/20260616140000_sprint27_campaign_startdate_country/migration.sql --schema prisma/schema.prisma
--
-- Two nullable columns land here:
--   1. startDate — the campaign's real start date (DATE). Optional + back-datable so a
--                  merchant can register a campaign that's already been running for a
--                  retrospective rollup. INFORMATIONAL ONLY: computeCampaignEconomics
--                  stays date-independent (it already pulls ALL tagged/auto-matched
--                  historical deals), so this column never changes the rollup math.
--   2. country   — the ONE country a campaign targets (ISO-3166 alpha-2, e.g. 'SA','TR').
--                  Nullable; free-text TEXT (validated to a 2-letter code in the API/UI).

ALTER TABLE "ad_campaigns" ADD COLUMN IF NOT EXISTS "startDate" DATE;
ALTER TABLE "ad_campaigns" ADD COLUMN IF NOT EXISTS "country"   TEXT;
