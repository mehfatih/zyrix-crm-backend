// ============================================================================
// AI STUDIO — saved scheduled AI reports (Sprint 13)
// ----------------------------------------------------------------------------
// A saved report is a free-text prompt run on a schedule (daily | weekly |
// manual). On run we ground gemini-2.5-flash on the SAME business snapshot the
// AI CFO / Executive Summary uses (reuse buildSnapshot), store lastResult, and
// email the recipients. Failures are logged per-report and never crash the
// cron loop (model-retirement runbook applies).
// ============================================================================

import { GoogleGenerativeAI } from "@google/generative-ai";
import { prisma } from "../config/database";
import { env } from "../config/env";
import { buildSnapshot } from "./ai-cfo.service";
import { getCompanyAIContext } from "./company-ai-profile.service";
import { sendEmail } from "./email.service";

const genAI = env.GEMINI_API_KEY ? new GoogleGenerativeAI(env.GEMINI_API_KEY) : null;

export type ReportSchedule = "daily" | "weekly" | "manual";

export interface SavedReport {
  id: string;
  companyId: string;
  name: string;
  prompt: string;
  schedule: ReportSchedule;
  recipients: string[];
  lastRunAt: string | null;
  lastResult: string | null;
  status: string;
  createdAt: string;
}

function parseRecipients(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function mapRow(r: any): SavedReport {
  return {
    id: r.id,
    companyId: r.companyId,
    name: r.name,
    prompt: r.prompt,
    schedule: r.schedule,
    recipients: parseRecipients(r.recipients),
    lastRunAt: r.lastRunAt ? r.lastRunAt.toISOString() : null,
    lastResult: r.lastResult ?? null,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
  };
}

// ── CRUD ─────────────────────────────────────────────────────────────────────
export async function listReports(companyId: string): Promise<SavedReport[]> {
  const rows = await prisma.savedAiReport.findMany({ where: { companyId }, orderBy: { createdAt: "desc" } });
  return rows.map(mapRow);
}

export async function getReport(companyId: string, id: string): Promise<SavedReport | null> {
  const r = await prisma.savedAiReport.findFirst({ where: { id, companyId } });
  return r ? mapRow(r) : null;
}

export async function createReport(
  companyId: string,
  userId: string,
  input: { name: string; prompt: string; schedule?: ReportSchedule; recipients?: string[] }
): Promise<SavedReport> {
  const r = await prisma.savedAiReport.create({
    data: {
      companyId,
      name: input.name.trim().slice(0, 160) || "Untitled report",
      prompt: input.prompt.trim().slice(0, 4000),
      schedule: input.schedule ?? "weekly",
      recipients: JSON.stringify((input.recipients ?? []).slice(0, 20)),
      createdBy: userId,
    },
  });
  return mapRow(r);
}

export async function updateReport(
  companyId: string,
  id: string,
  input: { name?: string; prompt?: string; schedule?: ReportSchedule; recipients?: string[]; status?: string }
): Promise<SavedReport> {
  const existing = await prisma.savedAiReport.findFirst({ where: { id, companyId } });
  if (!existing) throw Object.assign(new Error("Report not found"), { statusCode: 404 });
  const r = await prisma.savedAiReport.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim().slice(0, 160) } : {}),
      ...(input.prompt !== undefined ? { prompt: input.prompt.trim().slice(0, 4000) } : {}),
      ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
      ...(input.recipients !== undefined ? { recipients: JSON.stringify(input.recipients.slice(0, 20)) } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    },
  });
  return mapRow(r);
}

export async function deleteReport(companyId: string, id: string): Promise<void> {
  await prisma.savedAiReport.deleteMany({ where: { id, companyId } });
}

// ── Generation ─────────────────────────────────────────────────────────────
async function generateReportText(companyId: string, prompt: string): Promise<string> {
  if (!genAI) throw new Error("GEMINI_API_KEY is not configured");
  const snapshot = await buildSnapshot(companyId);
  const aiCtx = await getCompanyAIContext(companyId);
  const systemPrompt = `${aiCtx ? aiCtx + "\n\n" : ""}You are a precise business analyst for a company using the Zyrix CRM. Answer the user's report request using ONLY the JSON business snapshot provided. Reference real numbers, never fabricate. Be structured and concise (use short headings + bullets). If the data is insufficient, say so.

Today's date: ${snapshot.generatedAt.slice(0, 10)}`;
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: systemPrompt,
    generationConfig: { temperature: 0.4, maxOutputTokens: 1800 },
  });
  const userPrompt = `Report request: ${prompt}\n\nBusiness snapshot (JSON):\n${JSON.stringify(
    {
      company: snapshot.company,
      customers: snapshot.customers,
      deals: snapshot.deals,
      quotes: snapshot.quotes,
      loyalty: snapshot.loyalty,
    },
    null,
    2
  ).slice(0, 12000)}`;
  const result = await model.generateContent(userPrompt);
  return result.response.text().trim();
}

// Minimal markdown-ish → HTML for the email body (headings, bullets, bold).
function toHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let inList = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^[-*]\s+/.test(line)) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${esc(line.replace(/^[-*]\s+/, "")).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</li>`);
    } else {
      if (inList) { out.push("</ul>"); inList = false; }
      if (!line) { out.push("<br/>"); continue; }
      if (/^#{1,3}\s+/.test(line)) out.push(`<h3>${esc(line.replace(/^#{1,3}\s+/, ""))}</h3>`);
      else out.push(`<p>${esc(line).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</p>`);
    }
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
}

// Run a report now: generate, persist lastResult/lastRunAt, email recipients.
// Returns the generated text. Throws on generation failure (caller decides).
export async function runReport(companyId: string, id: string): Promise<string> {
  const report = await prisma.savedAiReport.findFirst({ where: { id, companyId } });
  if (!report) throw Object.assign(new Error("Report not found"), { statusCode: 404 });

  const text = await generateReportText(companyId, report.prompt);

  await prisma.savedAiReport.update({
    where: { id },
    data: { lastResult: text, lastRunAt: new Date() },
  });

  const recipients = parseRecipients(report.recipients);
  if (recipients.length > 0) {
    const html = `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#0A1530">
      <h2 style="color:#1A56DB">${report.name}</h2>
      <div style="font-size:14px;line-height:1.5">${toHtml(text)}</div>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0"/>
      <p style="font-size:12px;color:#64748b">Generated by Zyrix AI Studio · ${new Date().toISOString().slice(0, 10)}</p>
    </div>`;
    for (const to of recipients) {
      try {
        await sendEmail({ to, subject: `${report.name} — Zyrix report`, html });
      } catch {
        // per-recipient failure must not abort the others / the run
      }
    }
  }
  return text;
}

// ── Cron: run all due reports across all companies (per-report isolation) ────
export async function runDueReports(now: Date): Promise<{ ran: number; failed: number }> {
  const DAY = 86400000;
  const reports = await prisma.savedAiReport.findMany({
    where: { status: "active", schedule: { in: ["daily", "weekly"] } },
    select: { id: true, companyId: true, schedule: true, lastRunAt: true },
  });
  let ran = 0, failed = 0;
  for (const r of reports) {
    const sinceLast = r.lastRunAt ? now.getTime() - r.lastRunAt.getTime() : Infinity;
    const due = r.schedule === "daily" ? sinceLast >= 20 * 3600000 : sinceLast >= 6 * DAY;
    if (!due) continue;
    try {
      await runReport(r.companyId, r.id);
      ran++;
    } catch (e) {
      failed++;
      // Log to the row so the UI surfaces the failure; never throw out of the loop.
      try {
        await prisma.savedAiReport.update({
          where: { id: r.id },
          data: { lastRunAt: now, lastResult: `⚠️ Last run failed: ${(e as Error).message?.slice(0, 300) || "unknown error"}` },
        });
      } catch { /* swallow */ }
    }
  }
  return { ran, failed };
}
