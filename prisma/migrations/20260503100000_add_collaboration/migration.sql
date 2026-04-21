CREATE TABLE IF NOT EXISTS "notifications" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT,
  "link" TEXT,
  "entityType" TEXT,
  "entityId" TEXT,
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "notifications_companyId_userId_readAt_idx"
  ON "notifications"("companyId", "userId", "readAt");
CREATE INDEX IF NOT EXISTS "notifications_companyId_userId_createdAt_idx"
  ON "notifications"("companyId", "userId", "createdAt");

CREATE TABLE IF NOT EXISTS "comments" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "parentId" TEXT,
  "editedAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "comments_companyId_entityType_entityId_createdAt_idx"
  ON "comments"("companyId", "entityType", "entityId", "createdAt");
CREATE INDEX IF NOT EXISTS "comments_companyId_authorId_idx"
  ON "comments"("companyId", "authorId");
CREATE INDEX IF NOT EXISTS "comments_parentId_idx" ON "comments"("parentId");

CREATE TABLE IF NOT EXISTS "mentions" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "commentId" TEXT NOT NULL,
  "mentionedUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mentions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "mentions_commentId_mentionedUserId_key"
  ON "mentions"("commentId", "mentionedUserId");
CREATE INDEX IF NOT EXISTS "mentions_companyId_mentionedUserId_idx"
  ON "mentions"("companyId", "mentionedUserId");

ALTER TABLE "mentions" ADD CONSTRAINT "mentions_commentId_fkey"
  FOREIGN KEY ("commentId") REFERENCES "comments"("id") ON DELETE CASCADE;
