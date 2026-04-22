// ============================================================================
// BONUS TRACK SERVICES (B1-B10)
// ----------------------------------------------------------------------------
// Pragmatic minimum-viable implementations so the endpoints exist and the
// acceptance paths work end-to-end. Heuristics are intentionally simple;
// a future hardening pass can swap in Gemini-powered scoring / proper
// transcript processing / eIDAS-signed PDFs without changing the API
// contracts.
// ============================================================================

import crypto from "crypto";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { prisma } from "../config/database";
import { env } from "../config/env";
import { badRequest, notFound } from "../middleware/errorHandler";

const genAI = env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(env.GEMINI_API_KEY)
  : null;

// ──────────────────────────────────────────────────────────────────────
// B1 — Smart duplicate detection
// ──────────────────────────────────────────────────────────────────────

function normName(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9؀-ۿ\s]/g, "")
    .replace(/\s+/g, " ");
}
function normPhone(s: string | null | undefined): string {
  return (s ?? "").replace(/[^0-9+]/g, "");
}

export interface DuplicateCandidate {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  score: number; // 0..1
  reasons: string[];
}

export async function detectDuplicateCustomer(
  companyId: string,
  input: { fullName?: string; email?: string | null; phone?: string | null }
): Promise<DuplicateCandidate[]> {
  const wanted = {
    name: normName(input.fullName),
    email: (input.email ?? "").toLowerCase().trim(),
    phone: normPhone(input.phone),
  };
  if (!wanted.name && !wanted.email && !wanted.phone) return [];

  const candidates = await prisma.customer.findMany({
    where: {
      companyId,
      OR: [
        wanted.email ? { email: wanted.email } : undefined,
        wanted.phone
          ? { OR: [{ phone: wanted.phone }, { whatsappPhone: wanted.phone }] }
          : undefined,
        wanted.name
          ? {
              fullName: {
                contains: wanted.name.split(" ")[0],
                mode: "insensitive",
              },
            }
          : undefined,
      ].filter(Boolean) as any,
    },
    select: {
      id: true,
      fullName: true,
      email: true,
      phone: true,
      whatsappPhone: true,
    },
    take: 25,
  });

  const out: DuplicateCandidate[] = [];
  for (const c of candidates) {
    let score = 0;
    const reasons: string[] = [];
    if (
      wanted.email &&
      (c.email ?? "").toLowerCase().trim() === wanted.email
    ) {
      score += 0.6;
      reasons.push("email exact match");
    }
    const candPhones = [normPhone(c.phone), normPhone(c.whatsappPhone)].filter(
      Boolean
    );
    if (wanted.phone && candPhones.includes(wanted.phone)) {
      score += 0.35;
      reasons.push("phone exact match");
    }
    if (wanted.name) {
      const candName = normName(c.fullName);
      if (candName === wanted.name) {
        score += 0.25;
        reasons.push("name exact match");
      } else {
        const a = new Set(wanted.name.split(" "));
        const b = new Set(candName.split(" "));
        const overlap = [...a].filter((x) => b.has(x)).length;
        if (overlap > 0) {
          score += Math.min(0.2, overlap * 0.08);
          reasons.push(`name tokens shared: ${overlap}`);
        }
      }
    }
    if (score > 0.4) {
      out.push({
        id: c.id,
        fullName: c.fullName,
        email: c.email,
        phone: c.phone,
        score: Math.min(1, Number(score.toFixed(2))),
        reasons,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 5);
}

// ──────────────────────────────────────────────────────────────────────
// B2 — Conversation intelligence
// ──────────────────────────────────────────────────────────────────────

export interface ConversationSignal {
  sentiment: "positive" | "neutral" | "negative";
  buyingStage:
    | "awareness"
    | "consideration"
    | "decision"
    | "after_sale"
    | "unknown";
  urgency: "low" | "medium" | "high";
  objections: string[];
  suggestedNextStep: string | null;
}

export async function classifyConversation(
  text: string
): Promise<ConversationSignal> {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      sentiment: "neutral",
      buyingStage: "unknown",
      urgency: "low",
      objections: [],
      suggestedNextStep: null,
    };
  }
  if (!genAI) {
    // Heuristic fallback when Gemini isn't configured.
    const negHits =
      /(not|no|never|disappointed|angry|cancel|refund|complain)/i.test(trimmed)
        ? 1
        : 0;
    const posHits =
      /(thanks|great|love|perfect|awesome|excellent|happy|excited)/i.test(
        trimmed
      )
        ? 1
        : 0;
    const urgent =
      /(asap|urgent|immediately|today|now)/i.test(trimmed) ? "high" : "low";
    return {
      sentiment: posHits > negHits ? "positive" : negHits ? "negative" : "neutral",
      buyingStage: "unknown",
      urgency: urgent as "low" | "high",
      objections: [],
      suggestedNextStep: null,
    };
  }
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
  const prompt = `Classify this customer message. Reply strict JSON only.
{
  "sentiment": "positive|neutral|negative",
  "buyingStage": "awareness|consideration|decision|after_sale|unknown",
  "urgency": "low|medium|high",
  "objections": ["..."],
  "suggestedNextStep": "short action"
}

MESSAGE:
${trimmed.slice(0, 2000)}`;
  try {
    const out = (await model.generateContent(prompt)).response
      .text()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "");
    return JSON.parse(out) as ConversationSignal;
  } catch {
    return {
      sentiment: "neutral",
      buyingStage: "unknown",
      urgency: "low",
      objections: [],
      suggestedNextStep: null,
    };
  }
}

// ──────────────────────────────────────────────────────────────────────
// B3 — Predictive lead scoring (0-100, heuristic)
// ──────────────────────────────────────────────────────────────────────

export async function computeLeadScore(
  companyId: string,
  customerId: string
): Promise<number> {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, companyId },
    select: { id: true, email: true, phone: true, lifetimeValue: true },
  });
  if (!customer) return 0;

  const [activityCount, dealCount, wonDealCount] = await Promise.all([
    prisma.activity.count({ where: { companyId, customerId } }),
    prisma.deal.count({ where: { companyId, customerId } }),
    prisma.deal.count({
      where: { companyId, customerId, stage: "won" },
    }),
  ]);

  let score = 0;
  if (customer.email) score += 15;
  if (customer.phone) score += 10;
  if (Number(customer.lifetimeValue) > 0) score += 20;
  score += Math.min(25, activityCount * 3);
  score += Math.min(20, dealCount * 5);
  score += Math.min(30, wonDealCount * 10);

  return Math.min(100, Math.round(score));
}

export async function recomputeLeadScoresForCompany(
  companyId: string,
  limit = 500
): Promise<number> {
  const customers = await prisma.customer.findMany({
    where: { companyId },
    select: { id: true },
    take: limit,
    orderBy: { updatedAt: "desc" },
  });
  for (const c of customers) {
    const score = await computeLeadScore(companyId, c.id);
    await prisma.customer.update({
      where: { id: c.id },
      data: { leadScore: score, leadScoreUpdatedAt: new Date() },
    });
  }
  return customers.length;
}

// ──────────────────────────────────────────────────────────────────────
// B4 — Territory management
// ──────────────────────────────────────────────────────────────────────

export async function listTerritories(companyId: string) {
  return prisma.territory.findMany({
    where: { companyId },
    orderBy: { name: "asc" },
  });
}

export async function upsertTerritory(
  companyId: string,
  input: {
    id?: string;
    name: string;
    criteria: Record<string, unknown>;
    ownerId?: string | null;
  }
) {
  if (!input.name?.trim()) throw badRequest("name required");
  if (input.id) {
    return prisma.territory.update({
      where: { id: input.id },
      data: {
        name: input.name.trim(),
        criteria: input.criteria as any,
        ownerId: input.ownerId ?? null,
      },
    });
  }
  return prisma.territory.create({
    data: {
      companyId,
      name: input.name.trim(),
      criteria: input.criteria as any,
      ownerId: input.ownerId ?? null,
    },
  });
}

export async function assignTerritories(
  companyId: string
): Promise<{ assigned: number }> {
  const territories = await prisma.territory.findMany({
    where: { companyId },
  });
  if (territories.length === 0) return { assigned: 0 };
  const customers = await prisma.customer.findMany({
    where: { companyId, territory: null },
    select: { id: true, country: true, city: true, companyName: true, source: true },
    take: 2000,
  });
  let assigned = 0;
  for (const c of customers) {
    for (const t of territories) {
      const cr = (t.criteria as Record<string, any>) || {};
      const matches =
        (!cr.country ||
          (Array.isArray(cr.country) && cr.country.includes(c.country))) &&
        (!cr.city ||
          (Array.isArray(cr.city) && cr.city.includes(c.city))) &&
        (!cr.sourceContains ||
          (c.source ?? "")
            .toLowerCase()
            .includes(String(cr.sourceContains).toLowerCase())) &&
        (!cr.companyNameContains ||
          (c.companyName ?? "")
            .toLowerCase()
            .includes(String(cr.companyNameContains).toLowerCase()));
      if (matches) {
        await prisma.customer.update({
          where: { id: c.id },
          data: {
            territory: t.name,
            ...(t.ownerId ? { ownerId: t.ownerId } : {}),
          },
        });
        assigned++;
        break;
      }
    }
  }
  return { assigned };
}

// ──────────────────────────────────────────────────────────────────────
// B5 — Quota & forecasting
// ──────────────────────────────────────────────────────────────────────

export async function listQuotas(companyId: string) {
  return prisma.quota.findMany({
    where: { companyId },
    orderBy: [{ period: "desc" }, { userId: "asc" }],
  });
}

export async function upsertQuota(
  companyId: string,
  input: { userId: string; period: string; target: number }
) {
  if (!input.userId) throw badRequest("userId required");
  if (!input.period) throw badRequest("period required");
  if (input.target < 0) throw badRequest("target must be >= 0");
  return prisma.quota.upsert({
    where: {
      companyId_userId_period: {
        companyId,
        userId: input.userId,
        period: input.period,
      },
    },
    create: {
      companyId,
      userId: input.userId,
      period: input.period,
      target: input.target,
    },
    update: { target: input.target },
  });
}

export async function quotaAttainment(
  companyId: string,
  userId: string,
  period: string
) {
  const quota = await prisma.quota.findUnique({
    where: { companyId_userId_period: { companyId, userId, period } },
  });
  if (!quota) throw notFound("Quota");

  // Period → date range. Accepts YYYY, YYYY-MM, YYYY-Q1..Q4.
  const now = new Date();
  let from: Date;
  let to: Date;
  const yearMatch = /^(\d{4})(?:-(Q[1-4]|\d{1,2}))?$/.exec(period);
  if (yearMatch) {
    const y = Number(yearMatch[1]);
    const sub = yearMatch[2];
    if (!sub) {
      from = new Date(Date.UTC(y, 0, 1));
      to = new Date(Date.UTC(y, 11, 31, 23, 59, 59));
    } else if (sub.startsWith("Q")) {
      const qi = Number(sub[1]) - 1;
      from = new Date(Date.UTC(y, qi * 3, 1));
      to = new Date(Date.UTC(y, qi * 3 + 3, 0, 23, 59, 59));
    } else {
      const m = Number(sub) - 1;
      from = new Date(Date.UTC(y, m, 1));
      to = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59));
    }
  } else {
    from = new Date(now.getFullYear(), 0, 1);
    to = now;
  }

  const agg = await prisma.deal.aggregate({
    where: {
      companyId,
      ownerId: userId,
      stage: "won",
      actualCloseDate: { gte: from, lte: to },
    },
    _sum: { value: true },
    _count: { _all: true },
  });
  const actual = Number(agg._sum.value ?? 0);
  const target = Number(quota.target);
  return {
    quota,
    period,
    actual,
    target,
    attainmentPct:
      target > 0 ? Math.round((actual / target) * 100) : null,
    dealsWon: agg._count._all,
  };
}

// ──────────────────────────────────────────────────────────────────────
// B6 — Meeting intelligence
// ──────────────────────────────────────────────────────────────────────

export async function ingestMeeting(
  companyId: string,
  createdById: string,
  input: {
    title: string;
    transcript: string;
    customerId?: string;
    dealId?: string;
    meetingAt?: string | Date;
  }
) {
  if (!input.title?.trim()) throw badRequest("title required");
  if (!input.transcript?.trim()) throw badRequest("transcript required");

  let summary: string | null = null;
  let actionItems: string[] = [];
  if (genAI) {
    try {
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
      const prompt = `Summarize this meeting transcript in 3 bullet points, then list action items.
Return strict JSON: { "summary": "...", "actionItems": ["...", "..."] }

TRANSCRIPT:
${input.transcript.slice(0, 8000)}`;
      const raw = (await model.generateContent(prompt)).response
        .text()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/i, "");
      const parsed = JSON.parse(raw) as {
        summary?: string;
        actionItems?: string[];
      };
      summary = parsed.summary ?? null;
      actionItems = Array.isArray(parsed.actionItems)
        ? parsed.actionItems
        : [];
    } catch {
      // leave summary null
    }
  }

  return prisma.meeting.create({
    data: {
      companyId,
      createdById,
      title: input.title.trim(),
      transcript: input.transcript,
      summary,
      actionItems: actionItems as any,
      customerId: input.customerId ?? null,
      dealId: input.dealId ?? null,
      meetingAt: input.meetingAt ? new Date(input.meetingAt) : new Date(),
    },
  });
}

export async function listMeetings(companyId: string, limit = 50) {
  return prisma.meeting.findMany({
    where: { companyId },
    orderBy: { meetingAt: "desc" },
    take: limit,
  });
}

// ──────────────────────────────────────────────────────────────────────
// B7 — Native e-signature (simplified; eIDAS-grade cryptography deferred)
// ──────────────────────────────────────────────────────────────────────

export async function requestContractSignature(
  companyId: string,
  requestedBy: string,
  input: {
    contractId: string;
    signerEmail: string;
    signerName?: string;
  }
) {
  const contract = await prisma.contract.findFirst({
    where: { id: input.contractId, companyId },
    select: { id: true, title: true },
  });
  if (!contract) throw notFound("Contract");
  const token = crypto.randomBytes(24).toString("hex");
  const tokenExpiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 days
  return prisma.contractSignature.create({
    data: {
      companyId,
      contractId: contract.id,
      signerEmail: input.signerEmail.toLowerCase().trim(),
      signerName: input.signerName ?? null,
      token,
      tokenExpiresAt,
      requestedBy,
    },
  });
}

export async function completeContractSignature(
  token: string,
  signatureDataUrl: string
) {
  const row = await prisma.contractSignature.findFirst({
    where: { token },
  });
  if (!row) throw notFound("Signature request");
  if (row.signedAt) throw badRequest("Already signed");
  if (row.tokenExpiresAt.getTime() < Date.now())
    throw badRequest("Signing link has expired");
  return prisma.contractSignature.update({
    where: { id: row.id },
    data: {
      signatureDataUrl,
      signedAt: new Date(),
    },
  });
}

export async function listContractSignatures(
  companyId: string,
  contractId: string
) {
  return prisma.contractSignature.findMany({
    where: { companyId, contractId },
    orderBy: { requestedAt: "desc" },
  });
}

// ──────────────────────────────────────────────────────────────────────
// B8 — Customer health score (heuristic)
// ──────────────────────────────────────────────────────────────────────

export async function computeHealthScore(
  companyId: string,
  customerId: string
): Promise<number> {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, companyId },
    select: { lastContactAt: true, lifetimeValue: true, status: true },
  });
  if (!customer) return 0;
  let score = 50;
  // Recent contact boosts health
  if (customer.lastContactAt) {
    const days =
      (Date.now() - customer.lastContactAt.getTime()) / 86_400_000;
    if (days < 7) score += 30;
    else if (days < 30) score += 15;
    else if (days > 90) score -= 25;
  } else {
    score -= 15;
  }
  // Open deals vs lost deals
  const [openDeals, lostDeals] = await Promise.all([
    prisma.deal.count({
      where: {
        companyId,
        customerId,
        stage: { in: ["lead", "qualified", "proposal", "negotiation"] },
      },
    }),
    prisma.deal.count({
      where: { companyId, customerId, stage: "lost" },
    }),
  ]);
  score += Math.min(15, openDeals * 5);
  score -= Math.min(20, lostDeals * 5);
  if (customer.status === "lost") score -= 30;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export async function refreshHealthScoresForCompany(
  companyId: string,
  limit = 500
): Promise<number> {
  const customers = await prisma.customer.findMany({
    where: { companyId },
    select: { id: true },
    take: limit,
    orderBy: { updatedAt: "desc" },
  });
  for (const c of customers) {
    const score = await computeHealthScore(companyId, c.id);
    await prisma.customer.update({
      where: { id: c.id },
      data: {
        healthScore: score,
        healthScoreUpdatedAt: new Date(),
      },
    });
  }
  return customers.length;
}

// ──────────────────────────────────────────────────────────────────────
// B10 — Slack / MS Teams outgoing webhook
// ──────────────────────────────────────────────────────────────────────

export async function getSlackWebhook(companyId: string) {
  return prisma.slackWebhook.findUnique({ where: { companyId } });
}

export async function upsertSlackWebhook(
  companyId: string,
  addedBy: string,
  input: { url: string; eventTypes: string[] }
) {
  if (!/^https?:\/\//.test(input.url)) throw badRequest("url must be http(s)");
  return prisma.slackWebhook.upsert({
    where: { companyId },
    create: {
      companyId,
      url: input.url,
      eventTypes: input.eventTypes as any,
      addedBy,
    },
    update: {
      url: input.url,
      eventTypes: input.eventTypes as any,
    },
  });
}

export async function removeSlackWebhook(companyId: string) {
  await prisma.slackWebhook
    .delete({ where: { companyId } })
    .catch(() => {});
  return { deleted: true };
}

/**
 * Fire a Slack/Teams payload when an event happens. Call this from the
 * services that emit the corresponding events. We don't block the
 * primary action on delivery success.
 */
export async function notifySlack(
  companyId: string,
  eventType: string,
  text: string
): Promise<void> {
  try {
    const hook = await prisma.slackWebhook.findUnique({
      where: { companyId },
    });
    if (!hook) return;
    const list = Array.isArray(hook.eventTypes)
      ? (hook.eventTypes as unknown as string[])
      : [];
    if (list.length > 0 && !list.includes(eventType)) return;
    await fetch(hook.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error("[slack] webhook post failed:", err);
  }
}
