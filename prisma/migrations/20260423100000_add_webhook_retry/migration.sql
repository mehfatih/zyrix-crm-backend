-- ============================================================================
-- Webhook retry queue — add nextRetryAt column + composite index
-- ============================================================================

-- Add nextRetryAt column (nullable — set when status=failed, cleared on retry)
ALTER TABLE "webhook_events"
  ADD COLUMN IF NOT EXISTS "nextRetryAt" TIMESTAMP(3);

-- Composite index for the retry worker's hot query:
--   WHERE status = 'failed' AND nextRetryAt <= NOW()
-- This index makes the scan O(log n) even with millions of done events.
CREATE INDEX IF NOT EXISTS "webhook_events_status_nextRetryAt_idx"
  ON "webhook_events" ("status", "nextRetryAt");
