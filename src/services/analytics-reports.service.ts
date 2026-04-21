// ============================================================================
// ANALYTICS REPORTS SERVICE — metric catalog + runner
// ----------------------------------------------------------------------------
// Hardcoded catalog of analytical queries, each keyed by string. The
// interactive pivot builder AND the scheduled-reports cron execute against
// this catalog — single source of truth, consistent output shape.
//
// Adding a new metric is a one-file change: declare it in METRIC_CATALOG,
// implement the executor, both the UI and scheduled reports pick it up.
//
// Separate from the existing reports.service.ts which handles one-off
// pre-baked report pages (revenue report, pipeline report, etc.). This
// service is the foundation for the NEW pivot-style report builder.
// ============================================================================

import { prisma } from "../config/database";
import { badRequest } from "../middleware/errorHandler";

export interface MetricDefinition {
  key: string;
  label: { en: string; ar: string; tr: string };
  description: { en: string; ar: string; tr: string };
  category: "revenue" | "pipeline" | "customers" | "activity";
  chart: "bar" | "line" | "pie" | "table";
  columns: Array<{
    key: string;
    label: { en: string; ar: string; tr: string };
    kind: "text" | "number" | "currency" | "percent" | "date";
  }>;
}

export const METRIC_CATALOG: MetricDefinition[] = [
  {
    key: "revenue_by_month",
    label: { en: "Revenue by month", ar: "الإيرادات حسب الشهر", tr: "Aya göre gelir" },
    description: {
      en: "Monthly revenue from won deals over the last 12 months",
      ar: "الإيرادات الشهرية من الصفقات المكسوبة في آخر 12 شهر",
      tr: "Son 12 ayda kazanılan anlaşmalardan aylık gelir",
    },
    category: "revenue",
    chart: "line",
    columns: [
      { key: "month", label: { en: "Month", ar: "الشهر", tr: "Ay" }, kind: "text" },
      { key: "revenue", label: { en: "Revenue", ar: "الإيرادات", tr: "Gelir" }, kind: "currency" },
      { key: "count", label: { en: "Deals", ar: "الصفقات", tr: "Anlaşmalar" }, kind: "number" },
    ],
  },
  {
    key: "pipeline_by_stage",
    label: { en: "Pipeline by stage", ar: "المسار حسب المرحلة", tr: "Aşamaya göre pipeline" },
    description: {
      en: "Open deal count + total value per pipeline stage",
      ar: "عدد الصفقات المفتوحة + القيمة الإجمالية لكل مرحلة",
      tr: "Açık anlaşma sayısı + toplam değer",
    },
    category: "pipeline",
    chart: "bar",
    columns: [
      { key: "stage", label: { en: "Stage", ar: "المرحلة", tr: "Aşama" }, kind: "text" },
      { key: "count", label: { en: "Count", ar: "العدد", tr: "Adet" }, kind: "number" },
      { key: "totalValue", label: { en: "Total value", ar: "القيمة الإجمالية", tr: "Toplam değer" }, kind: "currency" },
    ],
  },
  {
    key: "conversion_rate",
    label: { en: "Conversion rate by stage", ar: "معدل التحويل حسب المرحلة", tr: "Aşamaya göre dönüşüm" },
    description: {
      en: "Percent of deals that progress from each stage to the next",
      ar: "نسبة الصفقات التي تنتقل من كل مرحلة للتالية",
      tr: "Her aşamadan sonrakine geçen anlaşmaların yüzdesi",
    },
    category: "pipeline",
    chart: "bar",
    columns: [
      { key: "stage", label: { en: "Stage", ar: "المرحلة", tr: "Aşama" }, kind: "text" },
      { key: "entered", label: { en: "Entered", ar: "دخلت", tr: "Girdi" }, kind: "number" },
      { key: "progressed", label: { en: "Progressed", ar: "تقدمت", tr: "İlerledi" }, kind: "number" },
      { key: "rate", label: { en: "Rate", ar: "النسبة", tr: "Oran" }, kind: "percent" },
    ],
  },
  {
    key: "top_customers_by_ltv",
    label: { en: "Top customers by LTV", ar: "أفضل العملاء بقيمة الحياة", tr: "YDD'ye göre en iyi müşteriler" },
    description: {
      en: "Top 10 customers ranked by cumulative revenue",
      ar: "أفضل 10 عملاء مرتبين حسب الإيرادات المتراكمة",
      tr: "Toplam gelire göre sıralanmış ilk 10 müşteri",
    },
    category: "customers",
    chart: "bar",
    columns: [
      { key: "fullName", label: { en: "Customer", ar: "العميل", tr: "Müşteri" }, kind: "text" },
      { key: "companyName", label: { en: "Company", ar: "الشركة", tr: "Şirket" }, kind: "text" },
      { key: "lifetimeValue", label: { en: "LTV", ar: "قيمة الحياة", tr: "YDD" }, kind: "currency" },
    ],
  },
  {
    key: "customers_by_source",
    label: { en: "Customers by source", ar: "العملاء حسب المصدر", tr: "Kaynağa göre müşteriler" },
    description: {
      en: "Where your customers came from",
      ar: "من أين جاء عملاؤك",
      tr: "Müşterilerinizin geldiği yerler",
    },
    category: "customers",
    chart: "pie",
    columns: [
      { key: "source", label: { en: "Source", ar: "المصدر", tr: "Kaynak" }, kind: "text" },
      { key: "count", label: { en: "Count", ar: "العدد", tr: "Adet" }, kind: "number" },
    ],
  },
  {
    key: "owner_performance",
    label: { en: "Performance by owner", ar: "الأداء حسب المسؤول", tr: "Sahibe göre performans" },
    description: {
      en: "Deals won/lost and revenue generated per deal owner",
      ar: "الصفقات المكسوبة/المفقودة والإيرادات لكل مسؤول",
      tr: "Anlaşma sahibi başına kazanılan/kaybedilen + gelir",
    },
    category: "pipeline",
    chart: "table",
    columns: [
      { key: "fullName", label: { en: "Owner", ar: "المسؤول", tr: "Sahip" }, kind: "text" },
      { key: "wonCount", label: { en: "Won", ar: "مكسوبة", tr: "Kazanılan" }, kind: "number" },
      { key: "lostCount", label: { en: "Lost", ar: "مفقودة", tr: "Kaybedilen" }, kind: "number" },
      { key: "revenue", label: { en: "Revenue", ar: "الإيرادات", tr: "Gelir" }, kind: "currency" },
      { key: "winRate", label: { en: "Win rate", ar: "نسبة الفوز", tr: "Kazanma oranı" }, kind: "percent" },
    ],
  },
  {
    key: "activity_volume",
    label: { en: "Activity volume", ar: "حجم النشاط", tr: "Etkinlik hacmi" },
    description: {
      en: "Calls, emails, meetings, tasks logged per day over last 30 days",
      ar: "المكالمات والإيميلات والاجتماعات والمهام يوميًا في آخر 30 يوم",
      tr: "Son 30 günde günlük kaydedilen arama, e-posta, toplantı, görev",
    },
    category: "activity",
    chart: "line",
    columns: [
      { key: "date", label: { en: "Date", ar: "التاريخ", tr: "Tarih" }, kind: "date" },
      { key: "calls", label: { en: "Calls", ar: "مكالمات", tr: "Arama" }, kind: "number" },
      { key: "emails", label: { en: "Emails", ar: "إيميلات", tr: "E-posta" }, kind: "number" },
      { key: "meetings", label: { en: "Meetings", ar: "اجتماعات", tr: "Toplantı" }, kind: "number" },
      { key: "tasks", label: { en: "Tasks", ar: "مهام", tr: "Görev" }, kind: "number" },
    ],
  },
];

export interface MetricResult {
  key: string;
  rows: Record<string, unknown>[];
  meta?: Record<string, unknown>;
}

export async function runMetric(
  companyId: string,
  key: string
): Promise<MetricResult> {
  switch (key) {
    case "revenue_by_month":
      return { key, rows: await revenueByMonth(companyId) };
    case "pipeline_by_stage":
      return { key, rows: await pipelineByStage(companyId) };
    case "conversion_rate":
      return { key, rows: await conversionRate(companyId) };
    case "top_customers_by_ltv":
      return { key, rows: await topCustomersByLtv(companyId) };
    case "customers_by_source":
      return { key, rows: await customersBySource(companyId) };
    case "owner_performance":
      return { key, rows: await ownerPerformance(companyId) };
    case "activity_volume":
      return { key, rows: await activityVolume(companyId) };
    default:
      throw badRequest(`Unknown metric: ${key}`);
  }
}

// ──────────────────────────────────────────────────────────────────────
// METRIC QUERIES
// ──────────────────────────────────────────────────────────────────────

async function revenueByMonth(companyId: string) {
  return (await prisma.$queryRawUnsafe(
    `SELECT TO_CHAR(DATE_TRUNC('month', "actualCloseDate"), 'YYYY-MM') AS month,
            COALESCE(SUM(value), 0)::float AS revenue,
            COUNT(*)::int AS count
     FROM deals
     WHERE "companyId" = $1 AND stage = 'won'
       AND "actualCloseDate" IS NOT NULL
       AND "actualCloseDate" >= NOW() - INTERVAL '12 months'
     GROUP BY month ORDER BY month ASC`,
    companyId
  )) as Array<{ month: string; revenue: number; count: number }>;
}

async function pipelineByStage(companyId: string) {
  return (await prisma.$queryRawUnsafe(
    `SELECT stage, COUNT(*)::int AS count,
            COALESCE(SUM(value), 0)::float AS "totalValue"
     FROM deals WHERE "companyId" = $1 AND stage NOT IN ('won', 'lost')
     GROUP BY stage
     ORDER BY CASE stage WHEN 'lead' THEN 1 WHEN 'qualified' THEN 2
       WHEN 'proposal' THEN 3 WHEN 'negotiation' THEN 4 ELSE 5 END`,
    companyId
  )) as Array<{ stage: string; count: number; totalValue: number }>;
}

async function conversionRate(companyId: string) {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT stage, COUNT(*)::int AS count FROM deals
     WHERE "companyId" = $1 GROUP BY stage`,
    companyId
  )) as Array<{ stage: string; count: number }>;
  const map = new Map(rows.map((r) => [r.stage, r.count]));
  const order = ["lead", "qualified", "proposal", "negotiation", "won"];
  const atOrPast = (s: string) => {
    const idx = order.indexOf(s);
    let total = 0;
    for (let i = idx; i < order.length; i++) total += map.get(order[i]) ?? 0;
    return total;
  };
  return ["lead", "qualified", "proposal", "negotiation"].map((s) => {
    const entered = atOrPast(s);
    const next = order[order.indexOf(s) + 1];
    const progressed = atOrPast(next);
    return {
      stage: s,
      entered,
      progressed,
      rate: entered > 0 ? progressed / entered : 0,
    };
  });
}

async function topCustomersByLtv(companyId: string) {
  const rows = await prisma.customer.findMany({
    where: { companyId, lifetimeValue: { gt: 0 } },
    select: { id: true, fullName: true, companyName: true, lifetimeValue: true },
    orderBy: { lifetimeValue: "desc" },
    take: 10,
  });
  return rows.map((r) => ({
    id: r.id,
    fullName: r.fullName,
    companyName: r.companyName ?? "",
    lifetimeValue: Number(r.lifetimeValue),
  }));
}

async function customersBySource(companyId: string) {
  return (await prisma.$queryRawUnsafe(
    `SELECT COALESCE(source, 'unknown') AS source, COUNT(*)::int AS count
     FROM customers WHERE "companyId" = $1
     GROUP BY source ORDER BY count DESC LIMIT 15`,
    companyId
  )) as Array<{ source: string; count: number }>;
}

async function ownerPerformance(companyId: string) {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT u.id, u."fullName",
            COUNT(*) FILTER (WHERE d.stage = 'won')::int AS "wonCount",
            COUNT(*) FILTER (WHERE d.stage = 'lost')::int AS "lostCount",
            COALESCE(SUM(d.value) FILTER (WHERE d.stage = 'won'), 0)::float AS revenue
     FROM users u
     LEFT JOIN deals d ON d."ownerId" = u.id AND d."companyId" = $1
     WHERE u."companyId" = $1
     GROUP BY u.id, u."fullName"
     ORDER BY revenue DESC LIMIT 25`,
    companyId
  )) as Array<{
    id: string; fullName: string; wonCount: number; lostCount: number; revenue: number;
  }>;
  return rows.map((r) => ({
    ...r,
    winRate: r.wonCount + r.lostCount > 0 ? r.wonCount / (r.wonCount + r.lostCount) : 0,
  }));
}

async function activityVolume(companyId: string) {
  return (await prisma.$queryRawUnsafe(
    `SELECT TO_CHAR(DATE_TRUNC('day', "createdAt"), 'YYYY-MM-DD') AS date,
            COUNT(*) FILTER (WHERE type = 'call')::int AS calls,
            COUNT(*) FILTER (WHERE type = 'email')::int AS emails,
            COUNT(*) FILTER (WHERE type = 'meeting')::int AS meetings,
            COUNT(*) FILTER (WHERE type = 'task')::int AS tasks
     FROM activities
     WHERE "companyId" = $1 AND "createdAt" >= NOW() - INTERVAL '30 days'
     GROUP BY date ORDER BY date ASC`,
    companyId
  )) as Array<{
    date: string; calls: number; emails: number; meetings: number; tasks: number;
  }>;
}

// ──────────────────────────────────────────────────────────────────────
// SCHEDULED REPORTS
// ──────────────────────────────────────────────────────────────────────

export interface ScheduledReportRow {
  id: string;
  companyId: string;
  createdById: string;
  name: string;
  cadence: string;
  hour: number;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  metrics: string[];
  recipients: string[];
  isEnabled: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listScheduledReports(companyId: string) {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id, "companyId", "createdById", name, cadence, hour,
            "dayOfWeek", "dayOfMonth", metrics, recipients,
            "isEnabled", "lastRunAt", "lastError", "createdAt", "updatedAt"
     FROM scheduled_reports WHERE "companyId" = $1
     ORDER BY "createdAt" DESC`,
    companyId
  )) as ScheduledReportRow[];
  return rows.map((r) => ({
    ...r,
    metrics: Array.isArray(r.metrics) ? r.metrics : [],
    recipients: Array.isArray(r.recipients) ? r.recipients : [],
  }));
}

export interface CreateScheduledReportInput {
  name: string;
  cadence: "daily" | "weekly" | "monthly";
  hour?: number;
  dayOfWeek?: number | null;
  dayOfMonth?: number | null;
  metrics: string[];
  recipients: string[];
  isEnabled?: boolean;
}

export async function createScheduledReport(
  companyId: string,
  userId: string,
  input: CreateScheduledReportInput
) {
  if (!input.name.trim()) throw badRequest("Name is required");
  if (!["daily", "weekly", "monthly"].includes(input.cadence)) {
    throw badRequest("cadence must be daily, weekly, or monthly");
  }
  if (input.metrics.length === 0) {
    throw badRequest("Select at least one metric");
  }
  // Validate all metric keys exist
  const known = new Set(METRIC_CATALOG.map((m) => m.key));
  for (const k of input.metrics) {
    if (!known.has(k)) throw badRequest(`Unknown metric: ${k}`);
  }
  if (input.recipients.length === 0) {
    throw badRequest("At least one recipient required");
  }

  const hour = Math.max(0, Math.min(input.hour ?? 9, 23));
  const dow =
    input.cadence === "weekly"
      ? Math.max(0, Math.min(input.dayOfWeek ?? 1, 6))
      : null;
  const dom =
    input.cadence === "monthly"
      ? Math.max(1, Math.min(input.dayOfMonth ?? 1, 28))
      : null;

  const rows = (await prisma.$queryRawUnsafe(
    `INSERT INTO scheduled_reports
       (id, "companyId", "createdById", name, cadence, hour, "dayOfWeek", "dayOfMonth",
        metrics, recipients, "isEnabled", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, NOW(), NOW())
     RETURNING id, "companyId", "createdById", name, cadence, hour,
               "dayOfWeek", "dayOfMonth", metrics, recipients,
               "isEnabled", "lastRunAt", "lastError", "createdAt", "updatedAt"`,
    companyId,
    userId,
    input.name.trim(),
    input.cadence,
    hour,
    dow,
    dom,
    JSON.stringify(input.metrics),
    JSON.stringify(input.recipients),
    input.isEnabled ?? true
  )) as ScheduledReportRow[];
  return rows[0];
}

export async function updateScheduledReport(
  companyId: string,
  id: string,
  patch: Partial<CreateScheduledReportInput>
) {
  const existing = (await prisma.$queryRawUnsafe(
    `SELECT id FROM scheduled_reports WHERE id = $1 AND "companyId" = $2`,
    id,
    companyId
  )) as { id: string }[];
  if (existing.length === 0) throw badRequest("Report not found");

  const updates: string[] = [];
  const values: any[] = [];
  let i = 1;
  const set = (col: string, val: any) => {
    updates.push(`"${col}" = $${i++}`);
    values.push(val);
  };
  if (patch.name !== undefined) set("name", patch.name);
  if (patch.cadence !== undefined) set("cadence", patch.cadence);
  if (patch.hour !== undefined) set("hour", Math.max(0, Math.min(patch.hour, 23)));
  if (patch.dayOfWeek !== undefined) set("dayOfWeek", patch.dayOfWeek);
  if (patch.dayOfMonth !== undefined) set("dayOfMonth", patch.dayOfMonth);
  if (patch.metrics !== undefined) {
    updates.push(`metrics = $${i++}::jsonb`);
    values.push(JSON.stringify(patch.metrics));
  }
  if (patch.recipients !== undefined) {
    updates.push(`recipients = $${i++}::jsonb`);
    values.push(JSON.stringify(patch.recipients));
  }
  if (patch.isEnabled !== undefined) set("isEnabled", patch.isEnabled);
  if (updates.length === 0) throw badRequest("No fields to update");
  updates.push(`"updatedAt" = NOW()`);
  values.push(id, companyId);
  await prisma.$executeRawUnsafe(
    `UPDATE scheduled_reports SET ${updates.join(", ")}
     WHERE id = $${i} AND "companyId" = $${i + 1}`,
    ...values
  );
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id, "companyId", "createdById", name, cadence, hour,
            "dayOfWeek", "dayOfMonth", metrics, recipients,
            "isEnabled", "lastRunAt", "lastError", "createdAt", "updatedAt"
     FROM scheduled_reports WHERE id = $1 AND "companyId" = $2`,
    id,
    companyId
  )) as ScheduledReportRow[];
  return rows[0];
}

export async function deleteScheduledReport(companyId: string, id: string) {
  await prisma.$executeRawUnsafe(
    `DELETE FROM scheduled_reports WHERE id = $1 AND "companyId" = $2`,
    id,
    companyId
  );
  return { deleted: true };
}
