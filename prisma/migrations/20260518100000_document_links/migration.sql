-- P9 — Document catalog (Google Drive links)

CREATE TABLE IF NOT EXISTS "document_links" (
  "id"          TEXT NOT NULL,
  "companyId"   TEXT NOT NULL,
  "entityType"  TEXT NOT NULL,
  "entityId"    TEXT NOT NULL,
  "googleDocId" TEXT NOT NULL,
  "title"       TEXT NOT NULL,
  "snippet"     TEXT,
  "addedBy"     TEXT NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastIndexed" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_links_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "document_links_entity_idx"
  ON "document_links"("companyId", "entityType", "entityId");
CREATE INDEX IF NOT EXISTS "document_links_googleDocId_idx"
  ON "document_links"("googleDocId");
