// ============================================================================
// SUPPORT — AI AGENT (Gemini)
// ----------------------------------------------------------------------------
// Reuses the @google/generative-ai client + GEMINI_API_KEY (same as ai.service)
// but with a SUPPORT-specific brain: Zyrix product knowledge + a feature→route
// navigation map, so it answers "where do I find X / how do I do X / is Z
// available / what does X do" with concrete steps and a deep-link.
//
// Distinct from the top-bar "Ask AI" (a CRM data assistant over records).
//
// MULTILINGUAL: detects the user's language and replies in THAT language (any
// language), even though the widget chrome stays en/ar/tr.
//
// Degrades gracefully: when GEMINI_API_KEY is missing, isConfigured() is false
// and callers route straight to a human/email instead of calling the model.
// ============================================================================

import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { env } from "../../config/env";
import { getCompanyAIContext } from "../company-ai-profile.service";

const genAI = env.GEMINI_API_KEY ? new GoogleGenerativeAI(env.GEMINI_API_KEY) : null;

export function isConfigured(): boolean {
  return Boolean(genAI);
}

// Feature → where it lives (sidebar group + route) + one-line purpose. Single
// source of truth for navigation answers; keep in sync with the sidebar.
const KNOWLEDGE_BASE = `
ZYRIX CRM — FEATURE & NAVIGATION MAP (route paths are relative; prepend the
active locale, e.g. /en/customers). Sidebar groups: Daily Ops, CRM Core,
Sales & Docs, Finance, Growth, Intelligence, AI & Automation.

DAILY OPS:
- Dashboard — /dashboard — KPIs, charts, priority actions.
- Inbox (unified) — /inbox — WhatsApp + Messenger + Instagram conversations; reply, filter by channel, attach to a deal.
- Tasks — /tasks — task management (todo/in_progress/done).
- Smart Follow-up — /followup — AI follow-up suggestions for stalled leads.
- Team Chat — /chat — internal team messaging.
CRM CORE:
- Customers — /customers — contacts, lead score, health score, custom fields.
- Deals — /deals — deal records.
- Pipeline — /pipeline — kanban; stages lead→qualified→proposal→negotiation→won/lost.
- Campaigns — /campaigns — email marketing campaigns (feature: marketing_automation).
SALES & DOCS:
- Quotes — /quotes (feature: quotes). Contracts — /contracts (feature: contracts).
- WhatsApp (legacy) — /whatsapp.
FINANCE:
- Cash Flow — /cashflow. Tax/KDV — /tax. Tax Invoices — /tax-invoices. Commission — /commission.
GROWTH:
- Loyalty Points — /loyalty. Integrations (40+ stores, Shopify…) — /settings/integrations.
- Lead Ads (Meta) — /integrations/lead-ads — Facebook/Instagram lead forms → pipeline.
INTELLIGENCE:
- Analytics — /analytics. Reports — /reports. Session KPIs — /session-kpis (managers).
AI & AUTOMATION:
- AI CFO — /ai-cfo. AI Agents — /ai. Automations/Workflows — /workflows. Templates — /templates.
BILLING/SETTINGS: plan & billing and integrations under Settings.
`.trim();

const SYSTEM_PROMPT = `You are Zyrix Support — the in-app AI support agent for Zyrix CRM merchants.
Be concrete, warm, and solution-oriented. Your job is to actually RESOLVE the
issue: explain what a feature does, give the exact steps, name the screen, and
point to where it lives. Do not loop; ask at most ONE clarifying question only
if truly necessary.

LANGUAGE: Detect the language the user is writing in and reply in THAT SAME
language (any language — Arabic, Turkish, English, French, etc.). Never switch
to a language the user didn't use.

USE THE KNOWLEDGE BASE BELOW for "where is X / how do I X / is Z available /
what does X do" questions. When a feature has a route, set "route" to that path
(without locale) so the app can deep-link the user there. Only set "route" when
you are confident the page matches; otherwise null.

ESCALATION: set "offerHandoff" true if the user explicitly asks for a human,
is frustrated, or you cannot resolve their issue from the knowledge base after
a reasonable attempt. Otherwise false.

Return STRICT JSON only.

KNOWLEDGE BASE:
${KNOWLEDGE_BASE}`;

export interface SupportTurn {
  sender: string; // user | ai | human | system
  body: string;
}

export interface AiReply {
  reply: string;
  offerHandoff: boolean;
  route: string | null;
}

const RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    reply: { type: SchemaType.STRING },
    offerHandoff: { type: SchemaType.BOOLEAN },
    route: { type: SchemaType.STRING, nullable: true },
  },
  required: ["reply", "offerHandoff"],
} as const;

/**
 * Generate the AI support reply for the latest user message given the history.
 * Throws only if the model call fails — callers treat any throw as "AI
 * unavailable" and fall back to offering a human.
 */
export async function generateReply(
  history: SupportTurn[],
  userMessage: string,
  companyId?: string
): Promise<AiReply> {
  if (!genAI) {
    return {
      reply: "",
      offerHandoff: true,
      route: null,
    };
  }
  // AI Studio: prepend the company's AI profile (tone/context/language) so the
  // support widget adopts the merchant's personality. Null-safe → no-op.
  const aiCtx = await getCompanyAIContext(companyId);
  const model = genAI.getGenerativeModel({
    // Current stable model with controlled generation (responseSchema) support.
    // gemini-2.0-flash and gemini-2.0-flash-exp were both retired by Google
    // (generateContent returns 404 "no longer available"), so all services
    // moved to gemini-2.5-flash.
    model: "gemini-2.5-flash",
    systemInstruction: aiCtx ? `${aiCtx}\n\n${SYSTEM_PROMPT}` : SYSTEM_PROMPT,
    generationConfig: {
      temperature: 0.4,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA as never,
    },
  });

  // Compact transcript (last ~16 turns) for context.
  const transcript = history
    .slice(-16)
    .map((t) => `${t.sender === "user" ? "USER" : t.sender === "ai" ? "ASSISTANT" : t.sender.toUpperCase()}: ${t.body}`)
    .join("\n");
  const prompt = `${transcript ? transcript + "\n" : ""}USER: ${userMessage}\n\nReply as Zyrix Support (JSON).`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();
  try {
    const parsed = JSON.parse(text) as Partial<AiReply>;
    return {
      reply: typeof parsed.reply === "string" ? parsed.reply : "",
      offerHandoff: Boolean(parsed.offerHandoff),
      route: typeof parsed.route === "string" && parsed.route.startsWith("/") ? parsed.route : null,
    };
  } catch {
    // Model returned non-JSON — use the raw text, no deep-link.
    return { reply: text.trim(), offerHandoff: false, route: null };
  }
}

/** Best-effort one-line subject from the first user message (for the console). */
export async function deriveSubject(firstUserMessage: string): Promise<string | null> {
  const trimmed = firstUserMessage.trim();
  if (!trimmed) return null;
  // Cheap heuristic — avoid an extra model call; the console just needs a hint.
  return trimmed.length > 80 ? trimmed.slice(0, 77) + "…" : trimmed;
}
