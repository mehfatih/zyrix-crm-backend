// ============================================================================
// LANDING PAGES — AI COPY GENERATION (Gemini) — Sprint 20 Phase B
// ----------------------------------------------------------------------------
// One-click: the merchant types one line ("سيروم فيتامين سي لتفتيح البشرة،
// توصيل للعراق") → Gemini fills every block's copy in the PAGE language,
// grounded on the linked product when a product block references one. Plus a
// per-block "regenerate". Returns blocks (caller persists on save); never
// invents structural props (productId/imageUrl/ctaHref are preserved).
// Mirrors the kb.service Gemini usage (gemini-2.5-flash + responseSchema).
// ============================================================================

import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { prisma } from "../config/database";
import { env } from "../config/env";
import type { LandingBlock, LandingPage } from "./landing-page.service";

const genAI = env.GEMINI_API_KEY ? new GoogleGenerativeAI(env.GEMINI_API_KEY) : null;

const LANG_LABEL: Record<string, string> = { en: "English", ar: "Arabic", tr: "Turkish" };
function langOf(locale: string): string {
  return LANG_LABEL[locale] ?? "Arabic";
}

// ── Per-block-type copy schemas ─────────────────────────────────────────────
const S = SchemaType;
const heroProps = { headline: { type: S.STRING }, subheadline: { type: S.STRING }, ctaText: { type: S.STRING } };
const benefitsProps = {
  title: { type: S.STRING },
  items: { type: S.ARRAY, items: { type: S.OBJECT, properties: { title: { type: S.STRING }, text: { type: S.STRING } }, required: ["title", "text"] } },
};
const productProps = { headline: { type: S.STRING }, ctaText: { type: S.STRING } };
const testimonialsProps = {
  title: { type: S.STRING },
  items: { type: S.ARRAY, items: { type: S.OBJECT, properties: { quote: { type: S.STRING }, author: { type: S.STRING } }, required: ["quote", "author"] } },
};
const faqProps = {
  title: { type: S.STRING },
  items: { type: S.ARRAY, items: { type: S.OBJECT, properties: { q: { type: S.STRING }, a: { type: S.STRING } }, required: ["q", "a"] } },
};
const formProps = { headline: { type: S.STRING }, subtext: { type: S.STRING } };
const footerProps = { text: { type: S.STRING } };

const SECTION_SCHEMA: Record<string, { type: SchemaType; properties: Record<string, unknown> }> = {
  hero: { type: S.OBJECT, properties: heroProps },
  benefits: { type: S.OBJECT, properties: benefitsProps },
  product: { type: S.OBJECT, properties: productProps },
  testimonials: { type: S.OBJECT, properties: testimonialsProps },
  faq: { type: S.OBJECT, properties: faqProps },
  form: { type: S.OBJECT, properties: formProps },
  footer: { type: S.OBJECT, properties: footerProps },
};

// ── Product grounding ───────────────────────────────────────────────────────
async function productContext(companyId: string, page: LandingPage): Promise<string> {
  const ids = [
    ...new Set(
      page.blocks
        .filter((b) => b.type === "product" && typeof b.props.productId === "string")
        .map((b) => b.props.productId as string)
    ),
  ];
  if (!ids.length) return "";
  const placeholders = ids.map((_, i) => `$${i + 2}`).join(",");
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT "name","description","price"::text AS "price","currency" FROM products
       WHERE "companyId" = $1 AND "id" IN (${placeholders})`,
    companyId,
    ...ids
  )) as Array<{ name: string; description: string | null; price: string | null; currency: string | null }>;
  if (!rows.length) return "";
  const lines = rows.map(
    (p) => `- ${p.name}${p.description ? `: ${p.description.slice(0, 300)}` : ""} (${p.price ?? "?"} ${p.currency ?? ""})`
  );
  return `\n\nLINKED PRODUCT(S) — ground the copy on these (use the real name; do not invent prices):\n${lines.join("\n")}`;
}

// ── Merge generated copy into a block, preserving structural props ───────────
function mergeBlock(block: LandingBlock, copy: Record<string, unknown> | undefined): LandingBlock {
  if (!copy || typeof copy !== "object") return block;
  const props = { ...block.props };
  const setStr = (k: string) => { if (typeof copy[k] === "string" && copy[k]) props[k] = copy[k]; };
  switch (block.type) {
    case "hero": setStr("headline"); setStr("subheadline"); setStr("ctaText"); break;
    case "product": setStr("headline"); setStr("ctaText"); break; // keep productId
    case "form": setStr("headline"); setStr("subtext"); break;
    case "footer": setStr("text"); break; // keep showPoweredBy
    case "benefits":
    case "testimonials":
    case "faq":
      setStr("title");
      if (Array.isArray(copy.items)) props.items = copy.items;
      break;
  }
  return { ...block, props };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Fill copy for EVERY block on the page from a one-line description, in the
 * page language. Returns the updated blocks (structural props preserved).
 * Returns null when no API key (caller degrades gracefully).
 */
export async function generatePageCopy(
  companyId: string,
  page: LandingPage,
  prompt: string
): Promise<LandingBlock[] | null> {
  if (!genAI) return null;
  const present = [...new Set(page.blocks.map((b) => b.type))].filter((t) => t in SECTION_SCHEMA);
  if (!present.length) return page.blocks;

  const properties: Record<string, unknown> = {};
  for (const t of present) properties[t] = SECTION_SCHEMA[t];
  const schema = { type: S.OBJECT, properties };

  const lang = langOf(page.locale);
  const ground = await productContext(companyId, page);

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction:
      `You are a senior direct-response copywriter for e-commerce campaign landing pages aimed at ` +
      `MENA / Gulf / Türkiye mobile buyers. Write ALL copy ENTIRELY in ${lang}. Be punchy, concrete, ` +
      `benefit-led and trustworthy — no hype, no false claims, no prices unless given. For benefits ` +
      `produce exactly 3 items; testimonials 2-3 realistic short quotes with plausible first-name authors; ` +
      `faq 3-5 buyer questions with clear answers. Keep headlines short. Use the romanized "Türkiye" ` +
      `(never "تركيا"). Return STRICT JSON for ONLY the requested sections.`,
    generationConfig: { temperature: 0.8, responseMimeType: "application/json", responseSchema: schema as never },
  });

  const promptText =
    `PRODUCT / OFFER (one line from the merchant):\n"${prompt.slice(0, 600)}"${ground}\n\n` +
    `Sections to write (JSON keys): ${present.join(", ")}.\n` +
    `Return JSON with one entry per section, all text in ${lang}.`;

  try {
    const result = await model.generateContent(promptText);
    const parsed = JSON.parse(result.response.text()) as Record<string, Record<string, unknown>>;
    return page.blocks.map((b) => mergeBlock(b, parsed[b.type]));
  } catch (err) {
    console.error("[landing-ai] generatePageCopy failed:", (err as Error).message);
    return null;
  }
}

/**
 * Regenerate copy for ONE block. Returns the updated block, or null on no-key /
 * unknown block / failure.
 */
export async function generateBlockCopy(
  companyId: string,
  page: LandingPage,
  blockId: string,
  prompt: string
): Promise<LandingBlock | null> {
  if (!genAI) return null;
  const block = page.blocks.find((b) => b.id === blockId);
  if (!block || !(block.type in SECTION_SCHEMA)) return null;

  const schema = SECTION_SCHEMA[block.type];
  const lang = langOf(page.locale);
  const ground = block.type === "product" ? await productContext(companyId, page) : "";

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction:
      `You are a senior direct-response copywriter for e-commerce campaign landing pages. Write ALL copy ` +
      `ENTIRELY in ${lang}. Punchy, concrete, benefit-led, trustworthy; no false claims; no prices unless ` +
      `given. For benefits produce exactly 3 items; testimonials 2-3 short quotes; faq 3-5 Q&A. Use the ` +
      `romanized "Türkiye". Return STRICT JSON for the single "${block.type}" section's fields only.`,
    generationConfig: { temperature: 0.9, responseMimeType: "application/json", responseSchema: schema as never },
  });

  const promptText =
    `PRODUCT / OFFER (one line):\n"${prompt.slice(0, 600)}"${ground}\n\n` +
    `Write the "${block.type}" block copy in ${lang}. Return STRICT JSON.`;

  try {
    const result = await model.generateContent(promptText);
    const parsed = JSON.parse(result.response.text()) as Record<string, unknown>;
    return mergeBlock(block, parsed);
  } catch (err) {
    console.error("[landing-ai] generateBlockCopy failed:", (err as Error).message);
    return null;
  }
}
