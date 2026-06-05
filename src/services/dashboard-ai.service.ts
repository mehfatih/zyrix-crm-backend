// ============================================================================
// DASHBOARD AI INSIGHT — Sprint 12
// ----------------------------------------------------------------------------
// Powers the `ai_insight` dashboard widget. Builds a compact, grounded
// snapshot of the company's real numbers (customers, open pipeline, recent
// wins, overdue tasks) and asks gemini-2.5-flash for a SHORT, plain-language
// observation + one suggested next action. Never fabricates: the model is
// told to reason only from the snapshot it is given.
//
// Results are cached in-memory per (company, focus) for 15 minutes so the
// widget — which fetches on mount + on manual refresh — doesn't re-bill
// Gemini on every dashboard load. The widget renders independently of this
// call (loading → cached text), so a slow/failed insight never blocks the
// rest of the dashboard. When the key is absent it degrades to a transparent
// rules-based summary of the same snapshot.
// ============================================================================

import { GoogleGenerativeAI } from "@google/generative-ai";
import { prisma } from "../config/database";
import { env } from "../config/env";

const genAI = env.GEMINI_API_KEY ? new GoogleGenerativeAI(env.GEMINI_API_KEY) : null;

export interface DashboardInsight {
  text: string;
  refreshedAt: string; // ISO
  cached: boolean;
  grounded: boolean; // true = had real data to reason from
}

interface Snapshot {
  customers: number;
  newCustomers30d: number;
  openDeals: number;
  openPipelineValue: number;
  wonValue30d: number;
  wonCount30d: number;
  overdueTasks: number;
  currency: string;
}

// focus → short steer for the model. Kept server-side so a client can't
// inject an arbitrary prompt; the widget only sends a focus key.
const FOCUS_STEER: Record<string, string> = {
  general: "overall health of the business right now",
  pipeline: "the open pipeline and what to prioritise to close deals",
  retention: "customer growth and retention",
  tasks: "overdue work and follow-ups that need attention",
};

const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { value: DashboardInsight; at: number }>();

async function buildSnapshot(companyId: string): Promise<Snapshot> {
  const now = Date.now();
  const since30 = new Date(now - 30 * 86400000);

  const [customers, newCustomers30d, openDeals, wonDeals, overdueTasks, company] =
    await Promise.all([
      prisma.customer.count({ where: { companyId } }),
      prisma.customer.count({ where: { companyId, createdAt: { gte: since30 } } }),
      prisma.deal.findMany({
        where: { companyId, stage: { notIn: ["won", "lost"] } },
        select: { value: true },
      }),
      prisma.deal.findMany({
        where: { companyId, stage: "won", updatedAt: { gte: since30 } },
        select: { value: true },
      }),
      prisma.task.count({
        where: {
          companyId,
          status: { notIn: ["done", "cancelled"] },
          dueDate: { lt: new Date(now) },
        },
      }),
      prisma.company.findUnique({
        where: { id: companyId },
        select: { baseCurrency: true },
      }),
    ]);

  const openPipelineValue = openDeals.reduce((s, d) => s + Number(d.value || 0), 0);
  const wonValue30d = wonDeals.reduce((s, d) => s + Number(d.value || 0), 0);

  return {
    customers,
    newCustomers30d,
    openDeals: openDeals.length,
    openPipelineValue,
    wonValue30d,
    wonCount30d: wonDeals.length,
    overdueTasks,
    currency: company?.baseCurrency || "USD",
  };
}

function isEmpty(s: Snapshot): boolean {
  return (
    s.customers === 0 &&
    s.openDeals === 0 &&
    s.wonCount30d === 0 &&
    s.overdueTasks === 0
  );
}

function fallbackText(s: Snapshot, focus: string): string {
  const c = s.currency;
  const bits: string[] = [];
  bits.push(`${s.customers} customers (${s.newCustomers30d} new in 30d).`);
  bits.push(`${s.openDeals} open deals worth ${c} ${Math.round(s.openPipelineValue).toLocaleString()}.`);
  if (s.wonCount30d > 0)
    bits.push(`Won ${s.wonCount30d} deals (${c} ${Math.round(s.wonValue30d).toLocaleString()}) in 30d.`);
  if (s.overdueTasks > 0) bits.push(`${s.overdueTasks} tasks are overdue — clear those first.`);
  else bits.push(`No overdue tasks — nicely on top of follow-ups.`);
  void focus;
  return bits.join(" ");
}

export async function getInsight(
  companyId: string,
  focusRaw: string | undefined,
  force = false
): Promise<DashboardInsight> {
  const focus = focusRaw && FOCUS_STEER[focusRaw] ? focusRaw : "general";
  const key = `${companyId}:${focus}`;

  if (!force) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return { ...hit.value, cached: true };
    }
  }

  const snap = await buildSnapshot(companyId);
  const grounded = !isEmpty(snap);
  const refreshedAt = new Date().toISOString();

  // No data yet, or no key → transparent rules-based summary.
  if (!grounded || !genAI) {
    const value: DashboardInsight = {
      text: grounded
        ? fallbackText(snap, focus)
        : "Not enough activity yet to draw an insight. Add customers and deals and this will fill in.",
      refreshedAt,
      cached: false,
      grounded,
    };
    cache.set(key, { value, at: Date.now() });
    return value;
  }

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = [
      "You are a concise CRM analyst. Using ONLY the JSON snapshot below, write a 2–3 sentence insight",
      `focused on ${FOCUS_STEER[focus]}. State one concrete observation grounded in the numbers, then one`,
      "specific next action. No greetings, no markdown, no bullet points, no fabricated numbers. Plain prose.",
      "",
      `Currency code: ${snap.currency}`,
      JSON.stringify({
        customers: snap.customers,
        newCustomersLast30Days: snap.newCustomers30d,
        openDeals: snap.openDeals,
        openPipelineValue: Math.round(snap.openPipelineValue),
        wonDealsLast30Days: snap.wonCount30d,
        wonValueLast30Days: Math.round(snap.wonValue30d),
        overdueTasks: snap.overdueTasks,
      }),
    ].join("\n");

    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const value: DashboardInsight = {
      text: text || fallbackText(snap, focus),
      refreshedAt,
      cached: false,
      grounded: true,
    };
    cache.set(key, { value, at: Date.now() });
    return value;
  } catch {
    // Degrade transparently — never surface a raw AI error on the dashboard.
    const value: DashboardInsight = {
      text: fallbackText(snap, focus),
      refreshedAt,
      cached: false,
      grounded: true,
    };
    cache.set(key, { value, at: Date.now() });
    return value;
  }
}
