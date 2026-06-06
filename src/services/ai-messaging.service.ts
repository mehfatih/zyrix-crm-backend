// ============================================================================
// AI MESSAGE COMPOSER (Sprint 15F) — real Gemini drafts grounded on the contact.
// ----------------------------------------------------------------------------
// Replaces the demo composer. Drafts emails/WhatsApp messages in the contact's
// language (country→lang), grounded on lightweight context (recent email/
// activity timeline + open-deal stage) + the company AI profile (S13). Degrades
// to a clear "AI unavailable" (null) when no key.
// ============================================================================

import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { prisma } from "../config/database";
import { env } from "../config/env";
import { getCompanyAIContext } from "./company-ai-profile.service";

const genAI = env.GEMINI_API_KEY ? new GoogleGenerativeAI(env.GEMINI_API_KEY) : null;

export type MessageTone = "professional" | "friendly" | "concise" | "persuasive";
export type MessageChannel = "email" | "whatsapp";
export type MessageLanguage = "ar" | "tr" | "en";

const AR_COUNTRIES = new Set(["SA", "AE", "EG", "QA", "KW", "BH", "OM", "JO", "LB", "IQ", "YE", "PS", "SY", "LY", "SD", "MA", "TN", "DZ"]);
function inferLang(country: string | null): MessageLanguage {
  if (!country) return "en";
  const c = country.toUpperCase();
  if (c === "TR") return "tr";
  if (AR_COUNTRIES.has(c)) return "ar";
  return "en";
}
const LANG_LABEL: Record<MessageLanguage, string> = { ar: "Arabic", tr: "Turkish", en: "English" };

export interface AIMessageDraft {
  id: string;
  tone: MessageTone;
  content: string;
  confidence: number;
  reasoning: string;
}

export interface DraftInput {
  contactId?: string;
  channel: MessageChannel;
  tones?: MessageTone[];
  language?: MessageLanguage;
  context?: string;
}

async function buildGrounding(companyId: string, contactId?: string): Promise<{ name: string; lang: MessageLanguage; summary: string }> {
  if (!contactId) return { name: "", lang: "en", summary: "" };
  const contact = await prisma.customer.findFirst({
    where: { id: contactId, companyId },
    select: { fullName: true, companyName: true, country: true, status: true },
  });
  if (!contact) return { name: "", lang: "en", summary: "" };

  const [emails, activities, deal] = await Promise.all([
    prisma.emailMessage.findMany({ where: { companyId, contactId }, orderBy: { sentAt: "desc" }, take: 3, select: { direction: true, subject: true, bodyPreview: true } }),
    prisma.activity.findMany({ where: { companyId, customerId: contactId }, orderBy: { createdAt: "desc" }, take: 3, select: { type: true, title: true } }),
    prisma.deal.findFirst({ where: { companyId, customerId: contactId, stage: { notIn: ["won", "lost"] } }, orderBy: { updatedAt: "desc" }, select: { title: true, stage: true, value: true, currency: true } }),
  ]);

  const lines: string[] = [];
  lines.push(`Contact: ${contact.fullName}${contact.companyName ? ` (${contact.companyName})` : ""}, status ${contact.status}.`);
  if (deal) lines.push(`Open deal: "${deal.title}" at stage ${deal.stage}, value ${Number(deal.value)} ${deal.currency}.`);
  if (emails.length) lines.push(`Recent emails: ${emails.map((e) => `${e.direction === "in" ? "they wrote" : "we sent"} "${e.subject ?? e.bodyPreview ?? ""}"`).join("; ")}.`);
  if (activities.length) lines.push(`Recent activity: ${activities.map((a) => `${a.type}: ${a.title}`).join("; ")}.`);
  return { name: contact.fullName, lang: inferLang(contact.country), summary: lines.join("\n") };
}

const DRAFTS_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    drafts: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          tone: { type: SchemaType.STRING },
          content: { type: SchemaType.STRING },
          reasoning: { type: SchemaType.STRING },
          confidence: { type: SchemaType.NUMBER },
        },
        required: ["tone", "content", "reasoning", "confidence"],
      },
    },
  },
  required: ["drafts"],
} as const;

export async function generateDrafts(companyId: string, input: DraftInput): Promise<AIMessageDraft[] | null> {
  if (!genAI) return null;
  const tones = (input.tones && input.tones.length ? input.tones : ["professional", "friendly", "concise"]) as MessageTone[];
  const grounding = await buildGrounding(companyId, input.contactId);
  const lang = input.language ?? grounding.lang;
  const aiCtx = await getCompanyAIContext(companyId);

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction:
      `${aiCtx ? aiCtx + "\n\n" : ""}You draft ${input.channel === "whatsapp" ? "WhatsApp messages" : "emails"} for a CRM user to send to a customer. Write ENTIRELY in ${LANG_LABEL[lang]}. ` +
      `Each draft must be personal, specific to the context, ${input.channel === "whatsapp" ? "short (2-3 sentences)" : "under 120 words"}, plain text, never spammy. ` +
      `Return one draft per requested tone with a one-line reasoning and a confidence 0-100.`,
    generationConfig: { temperature: 0.7, responseMimeType: "application/json", responseSchema: DRAFTS_SCHEMA as never },
  });

  const prompt = `Requested tones: ${tones.join(", ")}.
${grounding.summary ? `Context about the contact:\n${grounding.summary}` : `Context: ${input.context || "Follow up on the previous conversation."}`}
${input.context && grounding.summary ? `Additional intent: ${input.context}` : ""}
Output JSON { drafts: [{tone, content, reasoning, confidence}] } in ${LANG_LABEL[lang]}.`;

  try {
    const result = await model.generateContent(prompt);
    const parsed = JSON.parse(result.response.text()) as { drafts?: Array<{ tone: string; content: string; reasoning: string; confidence: number }> };
    if (!parsed.drafts?.length) return null;
    return parsed.drafts.map((d, i) => ({
      id: `d${i}`,
      tone: (tones.includes(d.tone as MessageTone) ? d.tone : tones[i] ?? "professional") as MessageTone,
      content: d.content,
      reasoning: d.reasoning || "",
      confidence: Math.max(0, Math.min(100, Math.round(Number(d.confidence) || 0))),
    }));
  } catch (e) {
    console.error("[ai-messaging] draft failed:", (e as Error).message);
    return null;
  }
}

async function singleText(companyId: string, system: string, user: string): Promise<string | null> {
  if (!genAI) return null;
  const aiCtx = await getCompanyAIContext(companyId);
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: aiCtx ? `${aiCtx}\n\n${system}` : system,
    generationConfig: { temperature: 0.5 },
  });
  try {
    const r = await model.generateContent(user);
    return r.response.text().trim() || null;
  } catch {
    return null;
  }
}

export async function improveTone(companyId: string, content: string, tone: MessageTone, language: MessageLanguage): Promise<string | null> {
  return singleText(companyId,
    `Rewrite the user's message in a ${tone} tone, entirely in ${LANG_LABEL[language]}. Keep the meaning; return only the rewritten message.`,
    content.slice(0, 4000));
}

export async function translateMessage(companyId: string, content: string, to: MessageLanguage): Promise<string | null> {
  return singleText(companyId,
    `Translate the user's message into ${LANG_LABEL[to]}. Return only the translation, preserving tone and line breaks.`,
    content.slice(0, 4000));
}
