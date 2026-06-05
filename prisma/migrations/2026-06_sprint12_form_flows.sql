-- Sprint 12 — Form Flows (Wizards + Kiosks)
-- ADDITIVE ONLY. Safe to re-run (IF NOT EXISTS everywhere).
-- Apply via: npx prisma db execute --file prisma/migrations/2026-06_sprint12_form_flows.sql --schema prisma/schema.prisma
-- then `npx prisma generate`. Do NOT run prisma migrate/db push.
-- NOTE: dashboard_layouts already exists (DashboardLayout model) — the dashboard
-- widget system is already server-persisted, so no dashboard table is created here.

CREATE TABLE IF NOT EXISTS form_flows (
  id TEXT PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'internal',   -- internal | public
  steps TEXT NOT NULL,                     -- JSON [{title, fields:[{key,type,label_en,label_ar,label_tr,required,options?}]}]
  mapping TEXT NOT NULL,                   -- JSON field key -> contact/deal field (+ createDeal:{stage, titleTemplate})
  "publicToken" TEXT UNIQUE,
  theme TEXT,                              -- JSON {logoUrl, accent, welcomeText i18n, thankYouText i18n}
  "kioskMode" BOOLEAN NOT NULL DEFAULT false,  -- auto-reset after submit (tablets)
  status TEXT NOT NULL DEFAULT 'draft',    -- draft | active | archived
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_form_flows_company ON form_flows("companyId", status);

CREATE TABLE IF NOT EXISTS form_submissions (
  id TEXT PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  "flowId" TEXT NOT NULL,
  data TEXT NOT NULL,                      -- JSON raw answers
  "createdContactId" TEXT,
  "createdDealId" TEXT,
  source TEXT NOT NULL DEFAULT 'public',   -- public | internal
  "submittedBy" TEXT,                      -- userId for internal wizards
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_form_submissions_flow ON form_submissions("flowId", "createdAt");
