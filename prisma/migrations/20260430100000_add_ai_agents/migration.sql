CREATE TABLE IF NOT EXISTS "ai_threads" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "agentKind" TEXT NOT NULL,
  "title" TEXT,
  "relatedActivityId" TEXT,
  "archived" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ai_threads_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ai_threads_companyId_userId_agentKind_idx"
  ON "ai_threads"("companyId", "userId", "agentKind");
CREATE INDEX IF NOT EXISTS "ai_threads_companyId_updatedAt_idx"
  ON "ai_threads"("companyId", "updatedAt");

CREATE TABLE IF NOT EXISTS "ai_messages" (
  "id" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "toolCall" JSONB,
  "promptTokens" INTEGER NOT NULL DEFAULT 0,
  "completionTokens" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ai_messages_threadId_createdAt_idx"
  ON "ai_messages"("threadId", "createdAt");

ALTER TABLE "ai_messages"
  ADD CONSTRAINT "ai_messages_threadId_fkey"
  FOREIGN KEY ("threadId") REFERENCES "ai_threads"("id") ON DELETE CASCADE;
