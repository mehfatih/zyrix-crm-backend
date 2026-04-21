CREATE TABLE IF NOT EXISTS "workflows" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "isEnabled" BOOLEAN NOT NULL DEFAULT true,
  "trigger" JSONB NOT NULL,
  "actions" JSONB NOT NULL DEFAULT '[]',
  "conditions" JSONB NOT NULL DEFAULT '[]',
  "runCount" INTEGER NOT NULL DEFAULT 0,
  "successCount" INTEGER NOT NULL DEFAULT 0,
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "lastRunAt" TIMESTAMP(3),
  "lastSuccessAt" TIMESTAMP(3),
  "lastFailureAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "workflows_companyId_idx" ON "workflows"("companyId");
CREATE INDEX IF NOT EXISTS "workflows_companyId_isEnabled_idx" ON "workflows"("companyId", "isEnabled");

CREATE TABLE IF NOT EXISTS "workflow_executions" (
  "id" TEXT NOT NULL,
  "workflowId" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "triggerPayload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "stepResults" JSONB NOT NULL DEFAULT '[]',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "nextRetryAt" TIMESTAMP(3),
  "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "workflow_executions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "workflow_executions_workflowId_idx" ON "workflow_executions"("workflowId");
CREATE INDEX IF NOT EXISTS "workflow_executions_companyId_idx" ON "workflow_executions"("companyId");
CREATE INDEX IF NOT EXISTS "workflow_executions_status_idx" ON "workflow_executions"("status");
CREATE INDEX IF NOT EXISTS "workflow_executions_status_nextRetryAt_idx" ON "workflow_executions"("status", "nextRetryAt");
CREATE INDEX IF NOT EXISTS "workflow_executions_companyId_queuedAt_idx" ON "workflow_executions"("companyId", "queuedAt");

ALTER TABLE "workflow_executions"
  ADD CONSTRAINT "workflow_executions_workflowId_fkey"
  FOREIGN KEY ("workflowId") REFERENCES "workflows"("id") ON DELETE CASCADE;
