-- Tasks table — dedicated task management separate from Activity timeline

CREATE TABLE IF NOT EXISTS "tasks" (
  "id"           TEXT PRIMARY KEY NOT NULL,
  "companyId"    TEXT NOT NULL,
  "createdById"  TEXT NOT NULL,
  "assignedToId" TEXT,
  "customerId"   TEXT,
  "dealId"       TEXT,

  "title"       TEXT NOT NULL,
  "description" TEXT,
  "status"      TEXT NOT NULL DEFAULT 'todo',
  "priority"    TEXT NOT NULL DEFAULT 'medium',

  "dueDate"     TIMESTAMP,
  "completedAt" TIMESTAMP,

  "metadata"    JSONB,

  "createdAt"   TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"   TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT "tasks_companyId_fkey"    FOREIGN KEY ("companyId")    REFERENCES "companies"("id") ON DELETE CASCADE,
  CONSTRAINT "tasks_createdById_fkey"  FOREIGN KEY ("createdById")  REFERENCES "users"("id")     ON DELETE NO ACTION,
  CONSTRAINT "tasks_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "users"("id")     ON DELETE SET NULL,
  CONSTRAINT "tasks_customerId_fkey"   FOREIGN KEY ("customerId")   REFERENCES "customers"("id") ON DELETE SET NULL,
  CONSTRAINT "tasks_dealId_fkey"       FOREIGN KEY ("dealId")       REFERENCES "deals"("id")     ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "tasks_companyId_idx"    ON "tasks"("companyId");
CREATE INDEX IF NOT EXISTS "tasks_assignedToId_idx" ON "tasks"("assignedToId");
CREATE INDEX IF NOT EXISTS "tasks_createdById_idx"  ON "tasks"("createdById");
CREATE INDEX IF NOT EXISTS "tasks_customerId_idx"   ON "tasks"("customerId");
CREATE INDEX IF NOT EXISTS "tasks_dealId_idx"       ON "tasks"("dealId");
CREATE INDEX IF NOT EXISTS "tasks_status_idx"       ON "tasks"("status");
CREATE INDEX IF NOT EXISTS "tasks_priority_idx"     ON "tasks"("priority");
CREATE INDEX IF NOT EXISTS "tasks_dueDate_idx"      ON "tasks"("dueDate");
