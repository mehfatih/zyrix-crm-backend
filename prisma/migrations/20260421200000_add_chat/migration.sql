-- Internal Chat — direct messages between team members
-- DM-only for MVP; channels can be added later via same tables with channelId

CREATE TABLE IF NOT EXISTS "chat_messages" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "companyId"   TEXT NOT NULL,
  "fromUserId"  TEXT NOT NULL,
  "toUserId"    TEXT NOT NULL,

  "content"     TEXT NOT NULL,
  "readAt"      TIMESTAMP,

  "createdAt"   TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "chat_messages_companyId_fkey"  FOREIGN KEY ("companyId")  REFERENCES "companies"("id") ON DELETE CASCADE,
  CONSTRAINT "chat_messages_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "users"("id")     ON DELETE CASCADE,
  CONSTRAINT "chat_messages_toUserId_fkey"   FOREIGN KEY ("toUserId")   REFERENCES "users"("id")     ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "chat_messages_companyId_idx"     ON "chat_messages"("companyId");
CREATE INDEX IF NOT EXISTS "chat_messages_fromUserId_idx"    ON "chat_messages"("fromUserId");
CREATE INDEX IF NOT EXISTS "chat_messages_toUserId_idx"      ON "chat_messages"("toUserId");
CREATE INDEX IF NOT EXISTS "chat_messages_createdAt_idx"     ON "chat_messages"("createdAt");
CREATE INDEX IF NOT EXISTS "chat_messages_readAt_idx"        ON "chat_messages"("readAt");
