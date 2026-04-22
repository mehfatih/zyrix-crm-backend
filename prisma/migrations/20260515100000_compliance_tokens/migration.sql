-- P6 — Compliance tokens (separate from JWT)

CREATE TABLE IF NOT EXISTS "compliance_tokens" (
  "id"         TEXT NOT NULL,
  "companyId"  TEXT NOT NULL,
  "label"      TEXT NOT NULL,
  "tokenHash"  TEXT NOT NULL,
  "prefix"     TEXT NOT NULL,
  "createdBy"  TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3),
  "revokedAt"  TIMESTAMP(3),
  CONSTRAINT "compliance_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "compliance_tokens_tokenHash_key"
  ON "compliance_tokens"("tokenHash");
CREATE INDEX IF NOT EXISTS "compliance_tokens_companyId_idx"
  ON "compliance_tokens"("companyId");
CREATE INDEX IF NOT EXISTS "compliance_tokens_prefix_idx"
  ON "compliance_tokens"("prefix");
