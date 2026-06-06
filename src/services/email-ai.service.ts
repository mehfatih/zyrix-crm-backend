// ============================================================================
// EMAIL AI DRAFT — Sprint 10 (Phase E)
// ----------------------------------------------------------------------------
// Generates a reply/outreach draft in the CONTACT's language (inferred from
// country), grounded on lightweight contact context. gemini-2.5-flash with a
// controlled JSON schema. Degrades to null when no API key.
// (Inbound-reply sentiment/intent analysis is DEFERRED — no receiving domain.)
// ============================================================================

import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { prisma } from "../config/database";
import { env } from "../config/env";
import { notFound } from "../middleware/errorHandler";

const genAI = env.GEMINI_API_KEY ? new GoogleGenerativeAI(env.GEMINI_API_KEY) : null;

export type DraftGoal = "follow_up" | "proposal_nudge" | "re_engage";

// Arabic-speaking countries → 'ar'; Türkiye → 'tr'; else 'en'.
const AR_COUNTRIES = new Set(["SA", "AE", "EG", "QA", "KW", "BH", "OM", "JO", "LB", "IQ", "YE", "PS", "SY", "LY", "SD", "MA", "TN", "DZ"]);
function inferLang(country: string | null): "ar" | "tr" | "en" {
  if (!country) return "en";
  const c = country.toUpperCase();
  if (c === "TR") return "tr";
  if (AR_COUNTRIES.has(c)) return "ar";
  return "en";
}

const LANG_LABEL = { ar: "Arabic", tr: "Turkish", en: "English" } as const;
const GOAL_BRIEF: Record<DraftGoal, string> = {
  follow_up: "a friendly follow-up after no response, keeping momentum without pressure",
  proposal_nudge: "a gentle nudge on a sent proposal/quote, inviting questions and a decision",
  re_engage: "a re-engagement note to a contact who has gone quiet, offering value",
};

const RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    subject: { type: SchemaType.STRING },
    body: { type: SchemaType.STRING },
  },
  required: ["subject", "body"],
} as const;

export interface DraftResult {
  subject: string;
  body: string;
  language: "ar" | "tr" | "en";
}

export async function generateEmailDraft(
  companyId: string,
  contactId: string,
  goal: DraftGoal
): Promise<DraftResult | null> {
  const contact = await prisma.customer.findFirst({
    where: { id: contactId, companyId },
    select: { fullName: true, companyName: true, country: true, status: true },
  });
  if (!contact) throw notFound("Contact");

  const lang = inferLang(contact.country);
  if (!genAI) return null; // no key → caller shows a graceful message

  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { name: true } });

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction:
      `You write concise, warm B2B sales emails for a CRM. Write ENTIRELY in ${LANG_LABEL[lang]}. ` +
      `Return a subject and a plain-text body (use line breaks, no markdown, no signature placeholder beyond the sender company name). ` +
      `Keep it under 120 words, personal, and specific — never spammy.`,
    generationConfig: {
      temperature: 0.7,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA as never,
    },
  });

  const prompt = `Write ${GOAL_BRIEF[goal]}.
Contact: ${contact.fullName}${contact.companyName ? ` (${contact.companyName})` : ""}.
Sender company: ${company?.name ?? "our company"}.
Output JSON {subject, body} in ${LANG_LABEL[lang]}.`;

  try {
    const result = await model.generateContent(prompt);
    const parsed = JSON.parse(result.response.text()) as Partial<DraftResult>;
    if (!parsed.body) return null;
    return {
      subject: typeof parsed.subject === "string" ? parsed.subject : "",
      body: parsed.body,
      language: lang,
    };
  } catch (err) {
    console.error("[email-ai] draft failed:", (err as Error).message);
    return null;
  }
}

// Sprint 15C — suggest a reply to a customer's inbound email. `emailId` is the
// inbound reply row (direction='in'); we ground on its text + the original
// subject + the contact's language. On-demand only — never auto-sent.
export async function generateReplyDraft(
  companyId: string,
  emailId: string
): Promise<DraftResult | null> {
  const msg = await prisma.emailMessage.findFirst({
    where: { id: emailId, companyId },
    select: { id: true, direction: true, body: true, bodyPreview: true, subject: true, contactId: true, replyToMessageId: true },
  });
  if (!msg) throw notFound("Email");

  // Resolve the customer's reply text + the original subject.
  let replyText = msg.body || msg.bodyPreview || "";
  let originalSubject = msg.subject || "";
  if (msg.replyToMessageId) {
    const orig = await prisma.emailMessage.findUnique({
      where: { id: msg.replyToMessageId },
      select: { subject: true },
    });
    if (orig?.subject) originalSubject = orig.subject;
  }
  if (!replyText.trim()) return null;

  const contact = msg.contactId
    ? await prisma.customer.findFirst({ where: { id: msg.contactId, companyId }, select: { fullName: true, companyName: true, country: true } })
    : null;
  const lang = inferLang(contact?.country ?? null);
  if (!genAI) return null;

  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { name: true } });

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction:
      `You draft a concise, helpful B2B reply to a customer's email, on behalf of a CRM user. ` +
      `Write ENTIRELY in ${LANG_LABEL[lang]}. Address their points directly, stay warm and specific, ` +
      `under 140 words, plain text (line breaks, no markdown). End with the sender company name only.`,
    generationConfig: { temperature: 0.6, responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA as never },
  });

  const prompt = `The customer ${contact?.fullName ?? ""}${contact?.companyName ? ` (${contact.companyName})` : ""} replied to our email "${originalSubject}".
Their reply:
"""
${replyText.slice(0, 4000)}
"""
Sender company: ${company?.name ?? "our company"}.
Write a suggested reply. Output JSON {subject, body} in ${LANG_LABEL[lang]}.`;

  try {
    const result = await model.generateContent(prompt);
    const parsed = JSON.parse(result.response.text()) as Partial<DraftResult>;
    if (!parsed.body) return null;
    return {
      subject: typeof parsed.subject === "string" ? parsed.subject : `RE: ${originalSubject}`,
      body: parsed.body,
      language: lang,
    };
  } catch (err) {
    console.error("[email-ai] reply draft failed:", (err as Error).message);
    return null;
  }
}
