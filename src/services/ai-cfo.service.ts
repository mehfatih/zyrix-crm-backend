import { GoogleGenerativeAI } from "@google/generative-ai";
import { prisma } from "../config/database";
import { env } from "../config/env";

// ============================================================================
// AI CFO SERVICE
// Aggregates company financial/operational data → prompts Gemini 2.0 Flash
// → returns narrative CFO-style analysis
// ============================================================================

const genAI = env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(env.GEMINI_API_KEY)
  : null;

export type Locale = "en" | "ar" | "tr";

export interface BusinessSnapshot {
  company: {
    id: string;
    name: string;
    plan: string;
    country: string | null;
    industry: string | null;
  };
  customers: {
    total: number;
    new30d: number;
    new7d: number;
    byStatus: Record<string, number>;
  };
  deals: {
    total: number;
    open: number;
    wonLast30d: number;
    wonValueLast30d: number;
    lostLast30d: number;
    inPipelineValue: number;
    weightedPipelineValue: number;
    byStage: Record<string, { count: number; value: number }>;
    avgDealSize: number;
  };
  quotes: {
    total: number;
    acceptedValueLast30d: number;
    pendingValue: number;
    acceptRate: number;
  };
  loyalty: {
    activeMembers: number;
    totalPointsIssued: number;
    totalPointsRedeemed: number;
  };
  activities: {
    last30d: number;
    byType: Record<string, number>;
  };
  tasks: {
    open: number;
    overdue: number;
    completedLast30d: number;
  };
  followup: {
    staleCustomers: number;
    criticalStale: number;
  };
  generatedAt: string;
}

export interface AIInsight {
  question: string;
  answer: string;
  snapshot: BusinessSnapshot;
  model: string;
  locale: Locale;
  generatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────
// BUILD BUSINESS SNAPSHOT
// ─────────────────────────────────────────────────────────────────────────
export async function buildSnapshot(
  companyId: string
): Promise<BusinessSnapshot> {
  const now = new Date();
  const thirty = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const seven = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [
    company,
    customerTotal,
    customerNew30,
    customerNew7,
    customerByStatusRaw,
    dealTotal,
    dealOpen,
    dealWon30,
    dealLost30,
    dealWonAggregate,
    pipelineAggregate,
    allOpenDeals,
    quoteTotal,
    quoteAccepted30,
    quotePendingAgg,
    quoteAcceptedAll,
    loyaltyMembers,
    loyaltyEarned,
    loyaltyRedeemed,
    activityLast30,
    activityByTypeRaw,
    taskOpen,
    taskOverdue,
    taskCompleted30,
  ] = await Promise.all([
    prisma.company.findUnique({
      where: { id: companyId },
      select: {
        id: true,
        name: true,
        plan: true,
        country: true,
        industry: true,
      },
    }),
    prisma.customer.count({ where: { companyId } }),
    prisma.customer.count({
      where: { companyId, createdAt: { gte: thirty } },
    }),
    prisma.customer.count({
      where: { companyId, createdAt: { gte: seven } },
    }),
    prisma.customer.groupBy({
      by: ["status"],
      where: { companyId },
      _count: { id: true },
    }),
    prisma.deal.count({ where: { companyId } }),
    prisma.deal.count({
      where: { companyId, stage: { notIn: ["won", "lost"] } },
    }),
    prisma.deal.count({
      where: {
        companyId,
        stage: "won",
        actualCloseDate: { gte: thirty },
      },
    }),
    prisma.deal.count({
      where: {
        companyId,
        stage: "lost",
        actualCloseDate: { gte: thirty },
      },
    }),
    prisma.deal.aggregate({
      where: {
        companyId,
        stage: "won",
        actualCloseDate: { gte: thirty },
      },
      _sum: { value: true },
    }),
    prisma.deal.aggregate({
      where: { companyId, stage: { notIn: ["won", "lost"] } },
      _sum: { value: true },
    }),
    prisma.deal.findMany({
      where: { companyId, stage: { notIn: ["won", "lost"] } },
      select: { stage: true, value: true, probability: true },
    }),
    prisma.quote.count({ where: { companyId } }),
    prisma.quote.aggregate({
      where: {
        companyId,
        status: "accepted",
        acceptedAt: { gte: thirty },
      },
      _sum: { total: true },
    }),
    prisma.quote.aggregate({
      where: { companyId, status: { in: ["sent", "viewed"] } },
      _sum: { total: true },
    }),
    prisma.quote.groupBy({
      by: ["status"],
      where: { companyId },
      _count: { id: true },
    }),
    prisma.loyaltyTransaction.findMany({
      where: { companyId },
      distinct: ["customerId"],
      select: { customerId: true },
    }),
    prisma.loyaltyTransaction.aggregate({
      where: { companyId, type: "earn" },
      _sum: { points: true },
    }),
    prisma.loyaltyTransaction.aggregate({
      where: { companyId, type: "redeem" },
      _sum: { points: true },
    }),
    prisma.activity.count({
      where: { companyId, createdAt: { gte: thirty } },
    }),
    prisma.activity.groupBy({
      by: ["type"],
      where: { companyId, createdAt: { gte: thirty } },
      _count: { id: true },
    }),
    prisma.task.count({
      where: { companyId, status: { in: ["todo", "in_progress"] } },
    }),
    prisma.task.count({
      where: {
        companyId,
        status: { in: ["todo", "in_progress"] },
        dueDate: { lt: now },
      },
    }),
    prisma.task.count({
      where: {
        companyId,
        status: "done",
        updatedAt: { gte: thirty },
      },
    }),
  ]);

  // Aggregates
  const wonValue30d = Number(dealWonAggregate._sum.value ?? 0);
  const pipelineValue = Number(pipelineAggregate._sum.value ?? 0);

  let weightedPipelineValue = 0;
  const byStage: Record<string, { count: number; value: number }> = {};
  for (const d of allOpenDeals) {
    const val = Number(d.value);
    weightedPipelineValue += val * (d.probability / 100);
    const s = byStage[d.stage] ?? { count: 0, value: 0 };
    s.count++;
    s.value += val;
    byStage[d.stage] = s;
  }

  const avgDealSize =
    dealWon30 > 0 ? wonValue30d / dealWon30 : 0;

  const byStatus: Record<string, number> = {};
  for (const s of customerByStatusRaw) {
    byStatus[s.status] = s._count.id;
  }

  const byType: Record<string, number> = {};
  for (const a of activityByTypeRaw) {
    byType[a.type] = a._count.id;
  }

  const quoteAcceptedCount = quoteAcceptedAll.find(
    (q) => q.status === "accepted"
  )?._count.id ?? 0;
  const quoteTotalNonDraft = quoteAcceptedAll
    .filter((q) => q.status !== "draft")
    .reduce((sum, q) => sum + q._count.id, 0);
  const acceptRate =
    quoteTotalNonDraft > 0 ? (quoteAcceptedCount / quoteTotalNonDraft) * 100 : 0;

  // Followup stale count (inline simplified — reuse logic concept)
  const warningCutoff = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
  const criticalCutoff = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
  const [staleCount, criticalStaleCount] = await Promise.all([
    prisma.customer.count({
      where: {
        companyId,
        status: { notIn: ["lost", "disabled"] },
        OR: [
          { lastContactAt: { lt: warningCutoff } },
          { lastContactAt: null },
        ],
      },
    }),
    prisma.customer.count({
      where: {
        companyId,
        status: { notIn: ["lost", "disabled"] },
        OR: [
          { lastContactAt: { lt: criticalCutoff } },
          { lastContactAt: null },
        ],
      },
    }),
  ]);

  return {
    company: {
      id: company?.id ?? companyId,
      name: company?.name ?? "Unknown",
      plan: company?.plan ?? "free",
      country: company?.country ?? null,
      industry: company?.industry ?? null,
    },
    customers: {
      total: customerTotal,
      new30d: customerNew30,
      new7d: customerNew7,
      byStatus,
    },
    deals: {
      total: dealTotal,
      open: dealOpen,
      wonLast30d: dealWon30,
      wonValueLast30d: Math.round(wonValue30d * 100) / 100,
      lostLast30d: dealLost30,
      inPipelineValue: Math.round(pipelineValue * 100) / 100,
      weightedPipelineValue: Math.round(weightedPipelineValue * 100) / 100,
      byStage,
      avgDealSize: Math.round(avgDealSize * 100) / 100,
    },
    quotes: {
      total: quoteTotal,
      acceptedValueLast30d:
        Math.round(Number(quoteAccepted30._sum.total ?? 0) * 100) / 100,
      pendingValue:
        Math.round(Number(quotePendingAgg._sum.total ?? 0) * 100) / 100,
      acceptRate: Math.round(acceptRate * 10) / 10,
    },
    loyalty: {
      activeMembers: loyaltyMembers.length,
      totalPointsIssued: loyaltyEarned._sum.points ?? 0,
      totalPointsRedeemed: Math.abs(loyaltyRedeemed._sum.points ?? 0),
    },
    activities: {
      last30d: activityLast30,
      byType,
    },
    tasks: {
      open: taskOpen,
      overdue: taskOverdue,
      completedLast30d: taskCompleted30,
    },
    followup: {
      staleCustomers: staleCount,
      criticalStale: criticalStaleCount,
    },
    generatedAt: now.toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// PROMPT TEMPLATES (for display in UI)
// ─────────────────────────────────────────────────────────────────────────
export const PROMPT_TEMPLATES = {
  en: [
    { id: "overview", label: "How's my business doing overall?" },
    { id: "cashflow", label: "What's blocking my cash flow?" },
    { id: "opportunities", label: "What are my top 3 opportunities right now?" },
    { id: "risks", label: "What are the biggest risks I should address?" },
    { id: "growth", label: "Where should I focus to grow faster?" },
    { id: "customers", label: "Which customers need immediate attention?" },
  ],
  ar: [
    { id: "overview", label: "كيف أداء عملي بشكل عام؟" },
    { id: "cashflow", label: "ما الذي يعيق تدفقي النقدي؟" },
    { id: "opportunities", label: "ما هي أفضل 3 فرص لدي الآن؟" },
    { id: "risks", label: "ما هي أكبر المخاطر التي يجب معالجتها؟" },
    { id: "growth", label: "أين يجب أن أركّز لأنمو أسرع؟" },
    { id: "customers", label: "أي عملاء يحتاجون اهتمامًا فوريًا؟" },
  ],
  tr: [
    { id: "overview", label: "İşim genel olarak nasıl gidiyor?" },
    { id: "cashflow", label: "Nakit akışımı ne engelliyor?" },
    { id: "opportunities", label: "Şu anda en iyi 3 fırsatım ne?" },
    { id: "risks", label: "Ele almam gereken en büyük riskler ne?" },
    { id: "growth", label: "Daha hızlı büyümek için nereye odaklanmalıyım?" },
    { id: "customers", label: "Hangi müşteriler acil ilgi gerektiriyor?" },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// ASK AI CFO
// ─────────────────────────────────────────────────────────────────────────
export async function askAICFO(
  companyId: string,
  question: string,
  locale: Locale = "en"
): Promise<AIInsight> {
  if (!genAI) {
    throw new Error("GEMINI_API_KEY is not configured");
  }
  if (!question.trim()) {
    const err: any = new Error("Question is required");
    err.statusCode = 400;
    throw err;
  }

  const snapshot = await buildSnapshot(companyId);

  const langInstruction =
    locale === "ar"
      ? "Respond entirely in Arabic (العربية). Use a professional but warm tone."
      : locale === "tr"
        ? "Respond entirely in Turkish. Use a professional but warm tone."
        : "Respond in English. Use a professional but warm tone.";

  const systemPrompt = `You are an AI CFO and business advisor for a small-to-medium business using the Zyrix CRM platform. Your job is to analyze their business data and give actionable, specific, honest advice — like a great fractional CFO would.

Rules:
- Be SPECIFIC. Reference actual numbers from the data.
- Be HONEST. If something looks weak, say so — diplomatically but clearly.
- Be ACTIONABLE. Every insight should lead to a concrete next step.
- Keep responses concise — 3-5 paragraphs max, with bullet points for recommendations.
- Don't hallucinate numbers not in the data.
- If data is too sparse to answer the question well, say so and suggest what data to collect.
- ${langInstruction}

Today's date: ${snapshot.generatedAt.slice(0, 10)}`;

  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash-exp",
    systemInstruction: systemPrompt,
    generationConfig: {
      temperature: 0.5,
      maxOutputTokens: 1500,
    },
  });

  const userPrompt = `Here is the business snapshot for "${snapshot.company.name}" (plan: ${snapshot.company.plan}${snapshot.company.industry ? `, industry: ${snapshot.company.industry}` : ""}${snapshot.company.country ? `, country: ${snapshot.company.country}` : ""}):

${JSON.stringify(
  {
    customers: snapshot.customers,
    deals: snapshot.deals,
    quotes: snapshot.quotes,
    loyalty: snapshot.loyalty,
    activities: snapshot.activities,
    tasks: snapshot.tasks,
    followup: snapshot.followup,
  },
  null,
  2
)}

Question from the founder: "${question}"

Analyze the data and respond.`;

  const result = await model.generateContent(userPrompt);
  const answer = result.response.text();

  return {
    question,
    answer,
    snapshot,
    model: "gemini-2.0-flash-exp",
    locale,
    generatedAt: new Date().toISOString(),
  };
}
