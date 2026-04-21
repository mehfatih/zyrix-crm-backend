// ============================================================================
// SCHEDULED REPORTS WORKER
// ----------------------------------------------------------------------------
// Runs hourly. For each enabled ScheduledReport whose cadence + hour +
// dayOfWeek/dayOfMonth matches the current UTC time, runs the report's
// metrics, formats an HTML digest, and emails it to each recipient.
//
// Errors are per-report — one failing report doesn't block the rest.
// lastRunAt + lastError columns give the UI enough info to show each
// report's health.
// ============================================================================

import cron from "node-cron";
import { prisma } from "../config/database";
import {
  runMetric,
  METRIC_CATALOG,
  type MetricDefinition,
  type MetricResult,
} from "../services/analytics-reports.service";
import { sendEmail } from "../services/email.service";

const CRON_EXPRESSION = "3 * * * *"; // :03 past every hour

let running = false;

interface EligibleReport {
  id: string;
  companyId: string;
  name: string;
  cadence: string;
  hour: number;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  metrics: string[];
  recipients: string[];
}

async function findEligibleReports(): Promise<EligibleReport[]> {
  const now = new Date();
  const hour = now.getUTCHours();
  const dow = now.getUTCDay();
  const dom = now.getUTCDate();

  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id, "companyId", name, cadence, hour, "dayOfWeek", "dayOfMonth",
            metrics, recipients
     FROM scheduled_reports
     WHERE "isEnabled" = true AND hour = $1
       AND (
         cadence = 'daily'
         OR (cadence = 'weekly' AND "dayOfWeek" = $2)
         OR (cadence = 'monthly' AND "dayOfMonth" = $3)
       )`,
    hour,
    dow,
    dom
  )) as Array<{
    id: string;
    companyId: string;
    name: string;
    cadence: string;
    hour: number;
    dayOfWeek: number | null;
    dayOfMonth: number | null;
    metrics: unknown;
    recipients: unknown;
  }>;

  return rows.map((r) => ({
    id: r.id,
    companyId: r.companyId,
    name: r.name,
    cadence: r.cadence,
    hour: r.hour,
    dayOfWeek: r.dayOfWeek,
    dayOfMonth: r.dayOfMonth,
    metrics: Array.isArray(r.metrics) ? (r.metrics as string[]) : [],
    recipients: Array.isArray(r.recipients) ? (r.recipients as string[]) : [],
  }));
}

function buildHtml(
  reportName: string,
  results: Array<{
    definition: MetricDefinition;
    result: MetricResult;
  }>
): string {
  const css = `
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
           background: #F0F9FF; color: #0c4a6e; margin: 0; padding: 20px; }
    .container { max-width: 720px; margin: 0 auto; background: white;
                 border: 1px solid #bae6fd; border-radius: 12px; overflow: hidden; }
    .header { background: linear-gradient(135deg, #0891B2, #38BDF8); color: white;
              padding: 20px 24px; }
    .header h1 { margin: 0; font-size: 18px; }
    .header .sub { opacity: 0.9; font-size: 12px; margin-top: 4px; }
    .body { padding: 20px 24px; }
    h2 { color: #0891B2; font-size: 15px; margin: 24px 0 8px 0; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th { background: #F0F9FF; color: #0c4a6e; font-weight: 600; padding: 8px 10px;
         border-bottom: 1px solid #bae6fd; text-align: left; font-size: 12px; }
    td { padding: 8px 10px; border-bottom: 1px solid #e0f2fe; font-size: 13px; }
    .footer { text-align: center; color: #64748b; font-size: 11px; padding: 16px; }
  `;

  const now = new Date();
  const sections = results
    .map((r) => {
      const { definition, result } = r;
      const rows = result.rows;
      if (rows.length === 0) {
        return `<h2>${definition.label.en}</h2><p style="color: #94a3b8; font-size: 12px;">No data available.</p>`;
      }
      const headers = definition.columns
        .map((c) => `<th>${c.label.en}</th>`)
        .join("");
      const dataRows = rows
        .slice(0, 20)
        .map((row) => {
          const cells = definition.columns
            .map((c) => {
              const val = (row as any)[c.key];
              let display: string = "";
              if (val === null || val === undefined) display = "—";
              else if (c.kind === "currency")
                display = Number(val).toLocaleString("en-US", {
                  style: "currency",
                  currency: "USD",
                  maximumFractionDigits: 0,
                });
              else if (c.kind === "percent")
                display = `${(Number(val) * 100).toFixed(1)}%`;
              else if (c.kind === "number")
                display = Number(val).toLocaleString("en-US");
              else display = String(val);
              return `<td>${display}</td>`;
            })
            .join("");
          return `<tr>${cells}</tr>`;
        })
        .join("");
      return `
        <h2>${definition.label.en}</h2>
        <p style="color: #64748b; font-size: 12px; margin: 0;">${definition.description.en}</p>
        <table><thead><tr>${headers}</tr></thead><tbody>${dataRows}</tbody></table>
      `;
    })
    .join("");

  return `<!DOCTYPE html>
    <html><head><style>${css}</style></head>
    <body>
      <div class="container">
        <div class="header">
          <h1>${reportName}</h1>
          <div class="sub">${now.toUTCString()}</div>
        </div>
        <div class="body">${sections}</div>
        <div class="footer">
          Powered by Zyrix CRM — <a href="https://crm.zyrix.co" style="color: #0891B2;">crm.zyrix.co</a>
        </div>
      </div>
    </body></html>`;
}

async function processReport(report: EligibleReport): Promise<void> {
  // Run each metric
  const results: Array<{ definition: MetricDefinition; result: MetricResult }> = [];
  for (const key of report.metrics) {
    const definition = METRIC_CATALOG.find((m) => m.key === key);
    if (!definition) continue;
    try {
      const result = await runMetric(report.companyId, key);
      results.push({ definition, result });
    } catch (e) {
      console.error(`[scheduled-reports] metric ${key} failed:`, (e as Error).message);
    }
  }

  if (results.length === 0) {
    throw new Error("No metrics produced usable output");
  }

  const html = buildHtml(report.name, results);
  const subject = `${report.name} — ${new Date().toDateString()}`;

  // Send to each recipient
  for (const to of report.recipients) {
    try {
      await sendEmail({ to, subject, html });
    } catch (e) {
      console.error(`[scheduled-reports] email to ${to} failed:`, (e as Error).message);
    }
  }
}

async function tick() {
  if (running) {
    console.log("[scheduled-reports] tick skipped — previous run still in flight");
    return;
  }
  running = true;
  try {
    const reports = await findEligibleReports();
    if (reports.length === 0) return;
    console.log(`[scheduled-reports] tick: ${reports.length} reports eligible`);
    for (const r of reports) {
      try {
        await processReport(r);
        await prisma.$executeRawUnsafe(
          `UPDATE scheduled_reports SET "lastRunAt" = NOW(), "lastError" = NULL WHERE id = $1`,
          r.id
        );
      } catch (e) {
        const msg = (e as Error).message.slice(0, 500);
        console.error(`[scheduled-reports] ${r.id} failed:`, msg);
        await prisma.$executeRawUnsafe(
          `UPDATE scheduled_reports SET "lastRunAt" = NOW(), "lastError" = $1 WHERE id = $2`,
          msg,
          r.id
        );
      }
    }
  } catch (e) {
    console.error("[scheduled-reports] tick errored:", (e as Error).message);
  } finally {
    running = false;
  }
}

export function startScheduledReportsWorker(): void {
  if (process.env.DISABLE_SCHEDULED_REPORTS === "true") {
    console.log("[scheduled-reports] DISABLED via env flag");
    return;
  }
  if (!cron.validate(CRON_EXPRESSION)) {
    console.error(`[scheduled-reports] invalid cron: ${CRON_EXPRESSION}`);
    return;
  }
  cron.schedule(CRON_EXPRESSION, () => {
    tick().catch((e) => console.error("[scheduled-reports] unhandled:", e));
  });
  console.log(
    `[scheduled-reports] worker registered — "${CRON_EXPRESSION}" (hourly at :03)`
  );
}
