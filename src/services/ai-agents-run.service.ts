// ============================================================================
// AI AGENTS v1 (Sprint 15F) — real lead-qualification agent.
// ----------------------------------------------------------------------------
// Replaces the demo agents widget. Scores + classifies recent NEW leads with
// gemini-2.5-flash grounded on contact context, writes leadScore +
// aiExtracted.qualification, and returns AgentOutput rows for the widget.
// ============================================================================

import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { prisma } from "../config/database";
import { env } from "../config/env";
import { getCompanyAIContext } from "./company-ai-profile.service";

const genAI = env.GEMINI_API_KEY ? new GoogleGenerativeAI(env.GEMINI_API_KEY) : null;

export interface AgentOutput {
  id: string;
  agentRole: "lead-qualification";
  permissionLevel: 1;
  insight: string;
  reason: string;
  confidence: number;
  signals: string[];
  recommendedAction: string;
  cta: { label: string; action: string };
  entityType: "contact";
  entityId: string;
  createdAt: string;
  status: "pending";
}

const QUALIFY_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    score: { type: SchemaType.NUMBER },
    classification: { type: SchemaType.STRING }, // hot | warm | cold
    reasoning: { type: SchemaType.STRING },
    signals: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
  },
  required: ["score", "classification", "reasoning"],
} as const;

async function leadContext(companyId: string, contactId: string): Promise<{ name: string; block: string } | null> {
  const c = await prisma.customer.findFirst({
    where: { id: contactId, companyId, deletedAt: null },
    select: { fullName: true, companyName: true, country: true, city: true, status: true, source: true, email: true, phone: true, leadScore: true },
  });
  if (!c) return null;
  const [activities, deal, emails] = await Promise.all([
    prisma.activity.findMany({ where: { companyId, customerId: contactId }, orderBy: { createdAt: "desc" }, take: 4, select: { type: true, title: true } }),
    prisma.deal.findFirst({ where: { companyId, customerId: contactId }, orderBy: { updatedAt: "desc" }, select: { title: true, stage: true, value: true, currency: true } }),
    prisma.emailMessage.count({ where: { companyId, contactId, direction: "in" } }),
  ]);
  const lines = [
    `Name: ${c.fullName}${c.companyName ? ` @ ${c.companyName}` : ""}`,
    `Location: ${[c.city, c.country].filter(Boolean).join(", ") || "unknown"}`,
    `Source: ${c.source ?? "unknown"} · Status: ${c.status}`,
    `Has email: ${!!c.email} · Has phone: ${!!c.phone} · Inbound emails: ${emails}`,
    deal ? `Deal: "${deal.title}" stage ${deal.stage}, ${Number(deal.value)} ${deal.currency}` : "No deal yet",
    activities.length ? `Activity: ${activities.map((a) => `${a.type}:${a.title}`).join("; ")}` : "No logged activity",
  ];
  return { name: c.fullName, block: lines.join("\n") };
}

export async function qualifyLead(companyId: string, contactId: string): Promise<AgentOutput | null> {
  if (!genAI) return null;
  const ctx = await leadContext(companyId, contactId);
  if (!ctx) return null;
  const aiCtx = await getCompanyAIContext(companyId);

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction:
      `${aiCtx ? aiCtx + "\n\n" : ""}You are a B2B lead-qualification analyst. Score how sales-ready a lead is from 0 (cold) to 100 (hot) using ONLY the provided context. ` +
      `classification: "hot" (>=70), "warm" (40-69), or "cold" (<40). Give 2-4 word signals and one-sentence reasoning. Be conservative when data is thin.`,
    generationConfig: { temperature: 0.2, responseMimeType: "application/json", responseSchema: QUALIFY_SCHEMA as never },
  });

  let parsed: { score: number; classification: string; reasoning: string; signals?: string[] };
  try {
    const r = await model.generateContent(`Lead context:\n${ctx.block}\n\nReturn JSON {score, classification, reasoning, signals}.`);
    parsed = JSON.parse(r.response.text());
  } catch (e) {
    console.error("[ai-agents] qualify failed:", (e as Error).message);
    return null;
  }

  const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0)));
  const classification = ["hot", "warm", "cold"].includes(parsed.classification) ? parsed.classification : score >= 70 ? "hot" : score >= 40 ? "warm" : "cold";

  // Persist: leadScore + reasoning into aiExtracted.qualification.
  const existing = await prisma.customer.findUnique({ where: { id: contactId }, select: { aiExtracted: true } });
  const ai = { ...((existing?.aiExtracted as object) ?? {}), qualification: { score, classification, reasoning: parsed.reasoning, at: new Date().toISOString() } };
  await prisma.customer.update({ where: { id: contactId }, data: { leadScore: score, leadScoreUpdatedAt: new Date(), aiExtracted: ai as any } });

  return {
    id: `lq-${contactId}`,
    agentRole: "lead-qualification",
    permissionLevel: 1,
    insight: `${ctx.name}: ${classification.toUpperCase()} lead (${score}/100)`,
    reason: parsed.reasoning,
    confidence: score,
    signals: Array.isArray(parsed.signals) ? parsed.signals.slice(0, 5) : [],
    recommendedAction: classification === "hot" ? "Reach out today" : classification === "warm" ? "Nurture this week" : "Monitor",
    cta: { label: "Open contact", action: `/customers/${contactId}` },
    entityType: "contact",
    entityId: contactId,
    createdAt: new Date().toISOString(),
    status: "pending",
  };
}

// Run the agent over recent new leads (cap N). Per-lead isolation.
export async function runLeadQualification(companyId: string, limit = 8): Promise<AgentOutput[]> {
  const leads = await prisma.customer.findMany({
    where: { companyId, deletedAt: null, status: "new" },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true },
  });
  const out: AgentOutput[] = [];
  for (const l of leads) {
    try {
      const o = await qualifyLead(companyId, l.id);
      if (o) out.push(o);
    } catch {
      /* skip this lead */
    }
  }
  return out;
}
