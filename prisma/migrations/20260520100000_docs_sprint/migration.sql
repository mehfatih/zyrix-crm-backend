-- Docs Sprint — knowledge-hub analytics + admin metadata
-- Creates doc_events (view/dwell/search/helpful) and doc_article_meta
-- (admin-editable overlay over markdown source of truth).

CREATE TABLE IF NOT EXISTS "doc_events" (
  "id" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "locale" TEXT NOT NULL,
  "category" TEXT,
  "slug" TEXT,
  "query" TEXT,
  "durationSeconds" INTEGER,
  "helpful" BOOLEAN,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "doc_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "doc_events_eventType_createdAt_idx"
  ON "doc_events"("eventType", "createdAt");
CREATE INDEX IF NOT EXISTS "doc_events_locale_category_slug_createdAt_idx"
  ON "doc_events"("locale", "category", "slug", "createdAt");
CREATE INDEX IF NOT EXISTS "doc_events_eventType_locale_createdAt_idx"
  ON "doc_events"("eventType", "locale", "createdAt");

CREATE TABLE IF NOT EXISTS "doc_article_meta" (
  "id" TEXT NOT NULL,
  "locale" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "title" TEXT,
  "plansJson" JSONB,
  "status" TEXT NOT NULL DEFAULT 'published',
  "recentlyUpdated" BOOLEAN NOT NULL DEFAULT false,
  "internalNotes" TEXT,
  "updatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "doc_article_meta_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "doc_article_meta_locale_category_slug_key"
  ON "doc_article_meta"("locale", "category", "slug");
CREATE INDEX IF NOT EXISTS "doc_article_meta_status_idx"
  ON "doc_article_meta"("status");
