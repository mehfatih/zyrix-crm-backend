-- Sprint 11 — Cadence stats attribution (additive)
-- Lets a tracked email carry the cadence step it belongs to, so opens/clicks
-- (Sprint 10 signals) increment the right cadence_step_stats row.
-- Apply via: npx prisma db execute --file prisma/migrations/2026-06_sprint11_cadence_stats.sql --schema prisma/schema.prisma
ALTER TABLE "email_messages" ADD COLUMN IF NOT EXISTS "cadenceId" TEXT;
ALTER TABLE "email_messages" ADD COLUMN IF NOT EXISTS "cadenceStepIndex" INTEGER;
