// ============================================================================
// DASHBOARD LAYOUT SERVICE
// ----------------------------------------------------------------------------
// Manages per-user customizable widget grids on the home dashboard. Falls
// back to the company-default layout (userId='company_default') when the
// user hasn't customized their own, and to a built-in default when neither
// exists. Uses raw SQL to dodge Prisma client regeneration dependencies.
// ============================================================================

import { prisma } from "../config/database";

// ──────────────────────────────────────────────────────────────────────
// Widget shape
// ──────────────────────────────────────────────────────────────────────
// id:      stable local id for drag-and-drop (uuid generated client-side)
// type:    which built-in widget to render (see WIDGET_TYPES in frontend)
// width:   "full" | "half" | "third" | "quarter" — grid column span
// config:  widget-specific settings (e.g. windowDays for a mini-chart)
// ──────────────────────────────────────────────────────────────────────

export interface Widget {
  id: string;
  type: string;
  width: "full" | "half" | "third" | "quarter";
  config?: Record<string, unknown>;
}

// Built-in default — shown to every user before they customize. Matches
// the layout the existing dashboard page renders, so switching from
// legacy → customizable feels seamless.
const DEFAULT_WIDGETS: Widget[] = [
  { id: "w-kpi-row", type: "kpi_row", width: "full" },
  { id: "w-revenue-trend", type: "revenue_trend", width: "half" },
  { id: "w-pipeline", type: "pipeline_snapshot", width: "half" },
  { id: "w-recent-deals", type: "recent_deals", width: "half" },
  { id: "w-upcoming-tasks", type: "upcoming_tasks", width: "half" },
  { id: "w-connected-stores", type: "connected_stores", width: "full" },
];

/**
 * Get the effective layout for a user. Resolution order:
 *   1. User's personal layout (companyId, userId)
 *   2. Company default (companyId, 'company_default')
 *   3. Built-in DEFAULT_WIDGETS
 */
export async function getLayout(
  companyId: string,
  userId: string
): Promise<{ widgets: Widget[]; source: "user" | "company" | "default" }> {
  type Row = { widgets: Widget[] };

  const personal = (await prisma.$queryRawUnsafe<Row[]>(
    `SELECT widgets FROM dashboard_layouts
     WHERE "companyId" = $1 AND "userId" = $2 LIMIT 1`,
    companyId,
    userId
  )) as Row[];
  if (personal.length > 0 && Array.isArray(personal[0].widgets)) {
    return { widgets: personal[0].widgets, source: "user" };
  }

  const company = (await prisma.$queryRawUnsafe<Row[]>(
    `SELECT widgets FROM dashboard_layouts
     WHERE "companyId" = $1 AND "userId" = 'company_default' LIMIT 1`,
    companyId
  )) as Row[];
  if (company.length > 0 && Array.isArray(company[0].widgets)) {
    return { widgets: company[0].widgets, source: "company" };
  }

  return { widgets: DEFAULT_WIDGETS, source: "default" };
}

// Valid widget types — matches the frontend registry. Widgets the user
// submits that aren't in this list get filtered out so a malformed POST
// from an old client (or a hand-crafted request) can't plant an
// unrenderable entry that breaks everyone else's dashboard when the
// company_default layout is used.
const VALID_TYPES = new Set([
  "kpi_row",
  "revenue_trend",
  "pipeline_snapshot",
  "recent_deals",
  "upcoming_tasks",
  "connected_stores",
  "cohort_snapshot",
  "funnel_snapshot",
  "customer_count",
  "deal_count",
  "won_this_month",
  "top_customers",
  "tasks_due_today",
  "unread_messages",
]);

const VALID_WIDTHS = new Set(["full", "half", "third", "quarter"]);

function sanitizeWidgets(input: unknown): Widget[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: Widget[] = [];
  // Cap at 24 widgets so a runaway client can't bloat the JSON column.
  for (const raw of input.slice(0, 24)) {
    if (!raw || typeof raw !== "object") continue;
    const w = raw as Record<string, unknown>;
    if (
      typeof w.id !== "string" ||
      typeof w.type !== "string" ||
      typeof w.width !== "string"
    ) {
      continue;
    }
    if (!VALID_TYPES.has(w.type) || !VALID_WIDTHS.has(w.width)) continue;
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    out.push({
      id: w.id,
      type: w.type,
      width: w.width as Widget["width"],
      config:
        w.config && typeof w.config === "object" && !Array.isArray(w.config)
          ? (w.config as Record<string, unknown>)
          : undefined,
    });
  }
  return out;
}

export async function saveLayout(
  companyId: string,
  userId: string,
  widgets: unknown
): Promise<{ widgets: Widget[] }> {
  const clean = sanitizeWidgets(widgets);
  const json = JSON.stringify(clean);

  await prisma.$executeRawUnsafe(
    `INSERT INTO dashboard_layouts (id, "companyId", "userId", widgets, "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, $3::jsonb, NOW(), NOW())
     ON CONFLICT ("companyId", "userId")
     DO UPDATE SET widgets = $3::jsonb, "updatedAt" = NOW()`,
    companyId,
    userId,
    json
  );

  return { widgets: clean };
}

export async function resetLayout(
  companyId: string,
  userId: string
): Promise<{ widgets: Widget[]; source: "company" | "default" }> {
  // Delete the user's personal row — future reads will fall through to
  // company default or built-in default.
  await prisma.$executeRawUnsafe(
    `DELETE FROM dashboard_layouts WHERE "companyId" = $1 AND "userId" = $2`,
    companyId,
    userId
  );
  const { widgets, source } = await getLayout(companyId, userId);
  return {
    widgets,
    source: source === "user" ? "default" : source,
  };
}
