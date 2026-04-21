CREATE TABLE IF NOT EXISTS "oauth_states" (
  "id" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "returnUrl" TEXT NOT NULL DEFAULT '/integrations',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_states_state_key" ON "oauth_states"("state");
CREATE INDEX IF NOT EXISTS "oauth_states_expiresAt_idx" ON "oauth_states"("expiresAt");
