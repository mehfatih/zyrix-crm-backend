import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../config/env";

// ============================================================================
// GEMINI AI SERVICE
// ============================================================================
// Extracts customer data from WhatsApp messages using Gemini 2.0 Flash.
// ============================================================================

const genAI = env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(env.GEMINI_API_KEY)
  : null;

export interface ExtractedCustomerData {
  fullName?: string;
  email?: string;
  companyName?: string;
  position?: string;
  location?: string;
  intent?: "inquiry" | "purchase" | "support" | "complaint" | "other";
  urgency?: "low" | "medium" | "high";
  budget?: string;
  productInterest?: string;
  sentiment?: "positive" | "neutral" | "negative";
  suggestedNextStep?: string;
  language?: "ar" | "en" | "tr" | "mixed";
  summary?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Extract customer data from a WhatsApp message
// ─────────────────────────────────────────────────────────────────────────
export async function extractCustomerDataFromMessage(
  messageText: string,
  previousContext?: string[]
): Promise<ExtractedCustomerData> {
  if (!genAI) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash-exp",
    generationConfig: {
      temperature: 0.3,
      responseMimeType: "application/json",
    },
  });

  const contextSection = previousContext?.length
    ? `\n\nPREVIOUS MESSAGES IN THIS CONVERSATION (for context):\n${previousContext.map((m, i) => `${i + 1}. ${m}`).join("\n")}`
    : "";

  const prompt = `You are an AI assistant for a CRM system targeting Middle East and Turkey markets.
Your job: Extract structured data from a WhatsApp message.

MESSAGE: "${messageText}"${contextSection}

Extract and return ONLY a JSON object with these fields (all optional — only include what's clearly mentioned):

{
  "fullName": "Person's full name if introduced",
  "email": "email@example.com",
  "companyName": "Company they represent",
  "position": "Their role/title",
  "location": "City or country",
  "intent": "inquiry | purchase | support | complaint | other",
  "urgency": "low | medium | high",
  "budget": "Budget mentioned (with currency)",
  "productInterest": "Product/service they're interested in",
  "sentiment": "positive | neutral | negative",
  "suggestedNextStep": "Brief action recommendation",
  "language": "ar | en | tr | mixed",
  "summary": "1-sentence summary of message intent"
}

IMPORTANT RULES:
- Understand Arabic dialects (Khaleeji, Egyptian, Levantine, Maghrebi), Turkish, and English
- If a field isn't mentioned or clear, OMIT it (don't guess)
- For "suggestedNextStep", think like a sales expert
- Detect urgency from phrases like "urgent", "ASAP", "عاجل", "ضروري", "acil"
- Return ONLY valid JSON, no markdown, no explanation`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const parsed = JSON.parse(text) as ExtractedCustomerData;
    return parsed;
  } catch (error) {
    console.error("[AI] Extraction failed:", error);
    return {
      summary: messageText.substring(0, 100),
      language: detectLanguage(messageText),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Detect language (fallback simple version)
// ─────────────────────────────────────────────────────────────────────────
function detectLanguage(text: string): "ar" | "en" | "tr" | "mixed" {
  const arabicPattern = /[\u0600-\u06FF]/;
  const turkishPattern = /[ğüşöçıİĞÜŞÖÇ]/;
  const hasArabic = arabicPattern.test(text);
  const hasTurkish = turkishPattern.test(text);
  if (hasArabic && !hasTurkish) return "ar";
  if (hasTurkish && !hasArabic) return "tr";
  if (hasArabic && hasTurkish) return "mixed";
  return "en";
}

// ─────────────────────────────────────────────────────────────────────────
// Generate a smart reply suggestion
// ─────────────────────────────────────────────────────────────────────────
export async function generateReplySuggestion(
  messageText: string,
  customerName?: string,
  language: "ar" | "en" | "tr" = "en"
): Promise<string> {
  if (!genAI) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash-exp",
    generationConfig: { temperature: 0.7 },
  });

  const languageInstruction = {
    ar: "Reply in professional Arabic, appropriate for MENA business context",
    en: "Reply in professional English",
    tr: "Reply in professional Turkish",
  }[language];

  const prompt = `You are a sales/support representative for a B2B SaaS company.
Customer ${customerName ? `named ${customerName} ` : ""}sent: "${messageText}"

${languageInstruction}. Keep the reply:
- Concise (2-3 sentences max)
- Professional but warm
- Action-oriented (suggest a next step)
- Culturally appropriate

Return ONLY the reply text, no explanation.`;

  try {
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (error) {
    console.error("[AI] Reply generation failed:", error);
    return "";
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Summarize a conversation
// ─────────────────────────────────────────────────────────────────────────
export async function summarizeConversation(
  messages: string[]
): Promise<string> {
  if (!genAI || messages.length === 0) {
    return "";
  }

  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash-exp",
    generationConfig: { temperature: 0.3 },
  });

  const prompt = `Summarize this WhatsApp conversation in 2-3 sentences. Focus on:
- What does the customer want?
- Any key details (budget, timeline, product interest)?
- What's the next logical step?

MESSAGES:
${messages.map((m, i) => `${i + 1}. ${m}`).join("\n")}

Return only the summary, no formatting.`;

  try {
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (error) {
    console.error("[AI] Summarization failed:", error);
    return "";
  }
}