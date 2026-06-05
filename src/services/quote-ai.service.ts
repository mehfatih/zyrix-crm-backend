// ============================================================================
// QUOTE AI SUGGESTION — Sprint 9
// ----------------------------------------------------------------------------
// Suggests a discount % for a new quote, grounded ONLY on the given customer's
// real history (accepted quotes + won deals) for this company. No history →
// null suggestion (never fabricate). Uses gemini-2.5-flash with a controlled
// JSON schema; when the key is absent it degrades to a transparent average of
// the customer's past accepted discounts (still grounded, still no fabrication).
// ============================================================================

import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { prisma } from "../config/database";
import { env } from "../config/env";

const genAI = env.GEMINI_API_KEY ? new GoogleGenerativeAI(env.GEMINI_API_KEY) : null;

export interface QuoteAiSuggestion {
  suggestedDiscountPct: number;
  rationale: string;
  confidence: number; // 0..1
}

interface HistorySnapshot {
  acceptedQuotes: Array<{ quoteNumber: string; discountPct: number; total: number; currency: string }>;
  wonDeals: Array<{ title: string; value: number; currency: string }>;
  avgAcceptedDiscountPct: number | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function buildSnapshot(
  companyId: string,
  customerId: string
): Promise<HistorySnapshot | null> {
  const [quotes, deals] = await Promise.all([
    prisma.quote.findMany({
      where: { companyId, customerId, status: "accepted" },
      select: { quoteNumber: true, subtotal: true, discountAmount: true, total: true, currency: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.deal.findMany({
      where: { companyId, customerId, stage: "won" },
      select: { title: true, value: true, currency: true },
      orderBy: { updatedAt: "desc" },
      take: 20,
    }),
  ]);

  if (quotes.length === 0 && deals.length === 0) return null;

  const acceptedQuotes = quotes.map((q) => {
    const subtotal = Number(q.subtotal);
    const discount = Number(q.discountAmount);
    const gross = subtotal + discount; // subtotal is net of discount
    const discountPct = gross > 0 ? round2((discount / gross) * 100) : 0;
    return { quoteNumber: q.quoteNumber, discountPct, total: Number(q.total), currency: q.currency };
  });

  const discounts = acceptedQuotes.map((q) => q.discountPct);
  const avgAcceptedDiscountPct = discounts.length
    ? round2(discounts.reduce((s, d) => s + d, 0) / discounts.length)
    : null;

  return {
    acceptedQuotes,
    wonDeals: deals.map((d) => ({ title: d.title, value: Number(d.value), currency: d.currency })),
    avgAcceptedDiscountPct,
  };
}

const RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    suggestedDiscountPct: { type: SchemaType.NUMBER },
    rationale: { type: SchemaType.STRING },
    confidence: { type: SchemaType.NUMBER },
  },
  required: ["suggestedDiscountPct", "rationale", "confidence"],
} as const;

const SYSTEM_PROMPT = `You are a B2B pricing assistant for a CRM. Given a customer's real
purchase history (accepted quotes with the discount % they accepted, and won deals),
suggest a single discount % to offer on a NEW quote that maximises the chance of
acceptance without giving away more margin than necessary.

Rules:
- Ground your suggestion ONLY in the provided history. Do NOT invent data.
- Stay within the range the customer has historically accepted; never exceed the
  highest discount they previously accepted by more than 2 percentage points.
- suggestedDiscountPct is a number 0-100. confidence is 0-1 (higher with more,
  more consistent history). rationale is ONE short sentence the salesperson can read.
- Write the rationale in Arabic.`;

export async function suggestQuoteDiscount(
  companyId: string,
  customerId: string,
  itemCount?: number
): Promise<QuoteAiSuggestion | null> {
  // Tenant check + history.
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, companyId },
    select: { id: true, fullName: true },
  });
  if (!customer) return null;

  const snapshot = await buildSnapshot(companyId, customerId);
  if (!snapshot) return null; // no history → no suggestion

  // Fallback (no API key): transparent average of past accepted discounts.
  if (!genAI) {
    if (snapshot.avgAcceptedDiscountPct == null) return null;
    return {
      suggestedDiscountPct: snapshot.avgAcceptedDiscountPct,
      rationale: `بناءً على متوسط الخصم الذي قبله هذا العميل في ${snapshot.acceptedQuotes.length} عرضًا سابقًا.`,
      confidence: Math.min(0.6, 0.2 + snapshot.acceptedQuotes.length * 0.1),
    };
  }

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      temperature: 0.3,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA as never,
    },
  });

  const prompt = `Customer history snapshot (JSON):
${JSON.stringify(snapshot, null, 2)}

The new quote currently has ${itemCount ?? "an unknown number of"} line item(s).
Suggest the discount % (JSON).`;

  try {
    const result = await model.generateContent(prompt);
    const parsed = JSON.parse(result.response.text()) as Partial<QuoteAiSuggestion>;
    const pct = Number(parsed.suggestedDiscountPct);
    const conf = Number(parsed.confidence);
    if (!Number.isFinite(pct)) return null;
    return {
      suggestedDiscountPct: Math.max(0, Math.min(100, round2(pct))),
      rationale:
        typeof parsed.rationale === "string" && parsed.rationale.trim()
          ? parsed.rationale.trim()
          : "اقتراح مبني على سجل هذا العميل.",
      confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
    };
  } catch (err) {
    console.error("[quote-ai] suggestion failed:", (err as Error).message);
    // Fall back to the grounded average rather than failing the request.
    if (snapshot.avgAcceptedDiscountPct == null) return null;
    return {
      suggestedDiscountPct: snapshot.avgAcceptedDiscountPct,
      rationale: `بناءً على متوسط الخصم الذي قبله هذا العميل سابقًا.`,
      confidence: 0.4,
    };
  }
}
