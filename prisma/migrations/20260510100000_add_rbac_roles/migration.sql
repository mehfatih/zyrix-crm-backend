-- P1 — Role-Based Access Control

CREATE TABLE IF NOT EXISTS "roles" (
  "id"          TEXT NOT NULL,
  "companyId"   TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "isSystem"    BOOLEAN NOT NULL DEFAULT false,
  "permissions" JSONB NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "roles_companyId_name_key"
  ON "roles"("companyId", "name");
CREATE INDEX IF NOT EXISTS "roles_companyId_idx"
  ON "roles"("companyId");

DO $$ BEGIN
  ALTER TABLE "roles" ADD CONSTRAINT "roles_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "customRoleId" TEXT;

CREATE INDEX IF NOT EXISTS "users_customRoleId_idx"
  ON "users"("customRoleId");

DO $$ BEGIN
  ALTER TABLE "users" ADD CONSTRAINT "users_customRoleId_fkey"
    FOREIGN KEY ("customRoleId") REFERENCES "roles"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
