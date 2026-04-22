-- P7 — SCIM 2.0 provisioning tokens

CREATE TABLE IF NOT EXISTS "scim_tokens" (
  "id"         TEXT NOT NULL,
  "companyId"  TEXT NOT NULL,
  "label"      TEXT NOT NULL,
  "tokenHash"  TEXT NOT NULL,
  "prefix"     TEXT NOT NULL,
  "createdBy"  TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3),
  "revokedAt"  TIMESTAMP(3),
  CONSTRAINT "scim_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "scim_tokens_tokenHash_key"
  ON "scim_tokens"("tokenHash");
CREATE INDEX IF NOT EXISTS "scim_tokens_companyId_idx"
  ON "scim_tokens"("companyId");
CREATE INDEX IF NOT EXISTS "scim_tokens_prefix_idx"
  ON "scim_tokens"("prefix");
