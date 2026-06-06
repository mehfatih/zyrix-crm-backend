-- Sprint 15 Phase C — inbound email replies (additive)
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS "repliedAt" TIMESTAMPTZ;
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS "replyToMessageId" TEXT;
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS body TEXT;
CREATE INDEX IF NOT EXISTS email_messages_reply_to_idx ON email_messages("replyToMessageId");
