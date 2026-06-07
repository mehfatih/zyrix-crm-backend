// ============================================================================
// KNOWLEDGE BASE — ARTICLES + CATEGORIES SERVICE (raw SQL) — Sprint 19
// ----------------------------------------------------------------------------
// Tenant-scoped (companyId). Trilingual title/body stored as per-locale JSONB
// {en,ar,tr} (body = Markdown text per locale). Raw-SQL tables (kb_categories,
// kb_articles), relation-free — accessed via $queryRawUnsafe, mirroring the
// Sprint 18 tickets pattern. Gated by the `knowledge_base` entitlement.
//
// Phase A: merchant CRUD + editor + AI "translate to the other two languages".
// (Portal browse/search + AI grounding land in Phase B; ticket→article in C.)
// ============================================================================

import { randomUUID } from "crypto";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { prisma } from "../config/database";
import { env } from "../config/env";
import { isEnabled } from "./entitlements.service";

const genAI = env.GEMINI_API_KEY ? new GoogleGenerativeAI(env.GEMINI_API_KEY) : null;

export type Locale = "en" | "ar" | "tr";
export const LOCALES: Locale[] = ["en", "ar", "tr"];
const LANG_LABEL: Record<Locale, string> = { en: "English", ar: "Arabic", tr: "Turkish" };

export type LocaleText = { en?: string; ar?: string; tr?: string };
export const ARTICLE_STATUSES = ["draft", "published"] as const;

export interface KbCategory {
  id: string;
  companyId: string;
  slug: string;
  name: LocaleText;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface KbArticle {
  id: string;
  companyId: string;
  slug: string;
  categoryId: string | null;
  status: string;
  title: LocaleText;
  body: LocaleText;
  viewCount: number;
  helpfulYes: number;
  helpfulNo: number;
  createdById: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/** Normalize a free-text locale map to {en,ar,tr} strings only (trimmed). */
function cleanLocaleText(v: unknown): LocaleText {
  const out: LocaleText = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const l of LOCALES) {
      const s = (v as Record<string, unknown>)[l];
      if (typeof s === "string" && s.trim()) out[l] = s.trim();
    }
  }
  return out;
}

/** First non-empty locale value (en → ar → tr) — used for slug + fallbacks. */
function firstText(t: LocaleText): string {
  return t.en || t.ar || t.tr || "";
}

/** ASCII-ish slug; falls back to a random short id for non-Latin-only titles. */
function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base || `article-${randomUUID().slice(0, 8)}`;
}

/** Ensure a slug is unique within the company for the given table. */
async function uniqueSlug(table: string, companyId: string, desired: string, ignoreId?: string): Promise<string> {
  let slug = desired;
  for (let i = 0; i < 50; i++) {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT "id" FROM ${table} WHERE "companyId" = $1 AND "slug" = $2 LIMIT 1`,
      companyId,
      slug
    )) as Array<{ id: string }>;
    if (!rows[0] || (ignoreId && rows[0].id === ignoreId)) return slug;
    slug = `${desired}-${i + 2}`;
  }
  return `${desired}-${randomUUID().slice(0, 6)}`;
}

// ──────────────────────────────────────────────────────────────────────
// Categories
// ──────────────────────────────────────────────────────────────────────

const CAT_COLS = `"id","companyId","slug","name","sortOrder","createdAt","updatedAt"`;

export async function listCategories(companyId: string): Promise<KbCategory[]> {
  return (await prisma.$queryRawUnsafe(
    `SELECT ${CAT_COLS} FROM kb_categories WHERE "companyId" = $1 ORDER BY "sortOrder" ASC, "createdAt" ASC`,
    companyId
  )) as KbCategory[];
}

export async function createCategory(
  companyId: string,
  input: { name?: LocaleText; sortOrder?: number }
): Promise<KbCategory> {
  const id = randomUUID();
  const name = cleanLocaleText(input.name);
  const slug = await uniqueSlug("kb_categories", companyId, slugify(firstText(name)));
  const sortOrder = Number.isFinite(input.sortOrder) ? Number(input.sortOrder) : 0;
  await prisma.$executeRawUnsafe(
    `INSERT INTO kb_categories ("id","companyId","slug","name","sortOrder","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4::jsonb,$5,NOW(),NOW())`,
    id,
    companyId,
    slug,
    JSON.stringify(name),
    sortOrder
  );
  return { id, companyId, slug, name, sortOrder, createdAt: new Date(), updatedAt: new Date() };
}

export async function updateCategory(
  companyId: string,
  id: string,
  patch: { name?: LocaleText; sortOrder?: number }
): Promise<KbCategory | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT ${CAT_COLS} FROM kb_categories WHERE "companyId" = $1 AND "id" = $2 LIMIT 1`,
    companyId,
    id
  )) as KbCategory[];
  const current = rows[0];
  if (!current) return null;
  const name = patch.name !== undefined ? cleanLocaleText(patch.name) : current.name;
  const sortOrder = patch.sortOrder !== undefined ? Number(patch.sortOrder) : current.sortOrder;
  await prisma.$executeRawUnsafe(
    `UPDATE kb_categories SET "name" = $3::jsonb, "sortOrder" = $4, "updatedAt" = NOW()
       WHERE "companyId" = $1 AND "id" = $2`,
    companyId,
    id,
    JSON.stringify(name),
    sortOrder
  );
  return { ...current, name, sortOrder, updatedAt: new Date() };
}

export async function deleteCategory(companyId: string, id: string): Promise<boolean> {
  // Detach articles (don't delete them) then remove the category.
  await prisma.$executeRawUnsafe(
    `UPDATE kb_articles SET "categoryId" = NULL, "updatedAt" = NOW()
       WHERE "companyId" = $1 AND "categoryId" = $2`,
    companyId,
    id
  );
  const n = await prisma.$executeRawUnsafe(
    `DELETE FROM kb_categories WHERE "companyId" = $1 AND "id" = $2`,
    companyId,
    id
  );
  return Number(n) > 0;
}

// ──────────────────────────────────────────────────────────────────────
// Articles
// ──────────────────────────────────────────────────────────────────────

const ART_COLS = `
  "id","companyId","slug","categoryId","status","title","body","viewCount",
  "helpfulYes","helpfulNo","createdById","publishedAt","createdAt","updatedAt"
`;

export async function listArticles(
  companyId: string,
  opts: { status?: string; categoryId?: string; q?: string } = {}
): Promise<KbArticle[]> {
  const params: unknown[] = [companyId];
  let where = `"companyId" = $1`;
  if (opts.status && (ARTICLE_STATUSES as readonly string[]).includes(opts.status)) {
    params.push(opts.status);
    where += ` AND "status" = $${params.length}`;
  }
  if (opts.categoryId) {
    params.push(opts.categoryId);
    where += ` AND "categoryId" = $${params.length}`;
  }
  if (opts.q && opts.q.trim()) {
    params.push(`%${opts.q.trim()}%`);
    const p = `$${params.length}`;
    // ILIKE across all locale values of title + body.
    where += ` AND ((("title")::text ILIKE ${p}) OR (("body")::text ILIKE ${p}))`;
  }
  return (await prisma.$queryRawUnsafe(
    `SELECT ${ART_COLS} FROM kb_articles WHERE ${where} ORDER BY "updatedAt" DESC`,
    ...params
  )) as KbArticle[];
}

export async function getArticle(companyId: string, id: string): Promise<KbArticle | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT ${ART_COLS} FROM kb_articles WHERE "companyId" = $1 AND "id" = $2 LIMIT 1`,
    companyId,
    id
  )) as KbArticle[];
  return rows[0] ?? null;
}

export interface ArticleInput {
  title?: LocaleText;
  body?: LocaleText;
  categoryId?: string | null;
  status?: string;
  slug?: string;
}

export async function createArticle(
  companyId: string,
  createdById: string | null,
  input: ArticleInput
): Promise<KbArticle> {
  const id = randomUUID();
  const title = cleanLocaleText(input.title);
  const body = cleanLocaleText(input.body);
  const status = (ARTICLE_STATUSES as readonly string[]).includes(input.status ?? "")
    ? (input.status as string)
    : "draft";
  const slug = await uniqueSlug(
    "kb_articles",
    companyId,
    slugify(input.slug || firstText(title))
  );
  const publishedAt = status === "published" ? new Date() : null;
  await prisma.$executeRawUnsafe(
    `INSERT INTO kb_articles
       ("id","companyId","slug","categoryId","status","title","body","viewCount",
        "helpfulYes","helpfulNo","createdById","publishedAt","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,0,0,0,$8,$9,NOW(),NOW())`,
    id,
    companyId,
    slug,
    input.categoryId ?? null,
    status,
    JSON.stringify(title),
    JSON.stringify(body),
    createdById,
    publishedAt
  );
  return (await getArticle(companyId, id))!;
}

export async function updateArticle(
  companyId: string,
  id: string,
  patch: Partial<ArticleInput>
): Promise<KbArticle | null> {
  const current = await getArticle(companyId, id);
  if (!current) return null;

  const title = patch.title !== undefined ? cleanLocaleText(patch.title) : current.title;
  const body = patch.body !== undefined ? cleanLocaleText(patch.body) : current.body;
  const categoryId =
    patch.categoryId !== undefined ? patch.categoryId : current.categoryId;
  const status =
    patch.status !== undefined && (ARTICLE_STATUSES as readonly string[]).includes(patch.status)
      ? patch.status
      : current.status;
  // Stamp publishedAt on the first transition to published; keep it otherwise.
  const publishedAt =
    status === "published" && !current.publishedAt ? new Date() : current.publishedAt;

  let slug = current.slug;
  if (patch.slug !== undefined && patch.slug.trim()) {
    slug = await uniqueSlug("kb_articles", companyId, slugify(patch.slug), id);
  }

  await prisma.$executeRawUnsafe(
    `UPDATE kb_articles
       SET "slug" = $3, "categoryId" = $4, "status" = $5,
           "title" = $6::jsonb, "body" = $7::jsonb, "publishedAt" = $8, "updatedAt" = NOW()
     WHERE "companyId" = $1 AND "id" = $2`,
    companyId,
    id,
    slug,
    categoryId ?? null,
    status,
    JSON.stringify(title),
    JSON.stringify(body),
    publishedAt
  );
  return (await getArticle(companyId, id))!;
}

export async function deleteArticle(companyId: string, id: string): Promise<boolean> {
  const n = await prisma.$executeRawUnsafe(
    `DELETE FROM kb_articles WHERE "companyId" = $1 AND "id" = $2`,
    companyId,
    id
  );
  return Number(n) > 0;
}

// ──────────────────────────────────────────────────────────────────────
// AI assist — translate title+body to the other two languages (Gemini)
// ──────────────────────────────────────────────────────────────────────

export interface TranslateResult {
  title: LocaleText;
  body: LocaleText;
}

/**
 * Given a source locale's title/body, translate to the OTHER two locales,
 * preserving Markdown. Returns only the two target locales filled in; the
 * caller merges with the source. Returns null when no API key (graceful).
 */
export async function translateArticle(
  sourceLocale: Locale,
  title: string,
  body: string
): Promise<TranslateResult | null> {
  if (!genAI) return null;
  const targets = LOCALES.filter((l) => l !== sourceLocale);

  const titleProps: Record<string, { type: SchemaType }> = {};
  const bodyProps: Record<string, { type: SchemaType }> = {};
  for (const t of targets) {
    titleProps[t] = { type: SchemaType.STRING };
    bodyProps[t] = { type: SchemaType.STRING };
  }
  const schema = {
    type: SchemaType.OBJECT,
    properties: {
      title: { type: SchemaType.OBJECT, properties: titleProps, required: targets },
      body: { type: SchemaType.OBJECT, properties: bodyProps, required: targets },
    },
    required: ["title", "body"],
  };

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction:
      `You are a professional localization engine for a help-center / knowledge base. ` +
      `Translate the given help article from ${LANG_LABEL[sourceLocale]} into the requested ` +
      `target languages. PRESERVE Markdown formatting exactly (headings, lists, links, code, bold). ` +
      `Do NOT translate code, URLs, or placeholder tokens. Keep the meaning faithful and natural; ` +
      `use the romanized "Türkiye" (never "تركيا"). Output STRICT JSON only.`,
    generationConfig: {
      temperature: 0.3,
      responseMimeType: "application/json",
      responseSchema: schema as never,
    },
  });

  const prompt =
    `Target languages: ${targets.map((t) => LANG_LABEL[t]).join(", ")} ` +
    `(JSON keys: ${targets.join(", ")}).\n\n` +
    `TITLE (${LANG_LABEL[sourceLocale]}):\n${title}\n\n` +
    `BODY (${LANG_LABEL[sourceLocale]}, Markdown):\n"""\n${body.slice(0, 12000)}\n"""\n\n` +
    `Return JSON {title:{...}, body:{...}} with one entry per target language.`;

  try {
    const result = await model.generateContent(prompt);
    const parsed = JSON.parse(result.response.text()) as TranslateResult;
    return { title: cleanLocaleText(parsed.title), body: cleanLocaleText(parsed.body) };
  } catch (err) {
    console.error("[kb] translate failed:", (err as Error).message);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Ticket → Article one-click (Phase C). Drafts a reusable article from a
// resolved ticket thread, in the thread's language, with personal data
// redacted. Always created as DRAFT — never auto-published.
// ──────────────────────────────────────────────────────────────────────

/** Strip obvious PII before the thread ever reaches the model (defense-in-depth). */
function redactPII(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\bhttps?:\/\/\S+/gi, "[link]")
    .replace(/(\+?\d[\d\s().-]{6,}\d)/g, "[phone]");
}

const DRAFT_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    locale: { type: SchemaType.STRING },
    title: { type: SchemaType.STRING },
    body: { type: SchemaType.STRING },
  },
  required: ["locale", "title", "body"],
} as const;

export async function draftArticleFromThread(
  companyId: string,
  input: { subject?: string | null; threadText: string },
  actorUserId: string | null
): Promise<{ article: KbArticle; locale: Locale } | null> {
  if (!genAI) return null;
  const raw = `${input.subject ? `Subject: ${input.subject}\n` : ""}${input.threadText}`;
  const redacted = redactPII(raw).slice(0, 8000);
  if (!redacted.trim()) return null;

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction:
      `You convert a resolved customer-support conversation into a reusable, public help-center article. ` +
      `Detect the dominant language of the conversation and set "locale" to ONE of: en, ar, tr ` +
      `(if it is some other language, use en). Write the article ENTIRELY in that language. ` +
      `CRITICAL — remove ALL personal/identifying data: customer or agent names, phone numbers, emails, ` +
      `addresses, order/invoice/account numbers, links — generalize them ("a customer", "your order"). ` +
      `Never address or name the specific customer. Produce a clear, reusable article: a short title and a ` +
      `Markdown body (the problem/question + the solution or steps). Use the romanized "Türkiye". ` +
      `Return STRICT JSON {locale, title, body}.`,
    generationConfig: {
      temperature: 0.3,
      responseMimeType: "application/json",
      responseSchema: DRAFT_SCHEMA as never,
    },
  });

  const prompt = `Resolved support conversation:\n"""\n${redacted}\n"""\n\nDraft the help article as JSON {locale, title, body}.`;
  try {
    const result = await model.generateContent(prompt);
    const parsed = JSON.parse(result.response.text()) as { locale?: string; title?: string; body?: string };
    if (!parsed.title?.trim() || !parsed.body?.trim()) return null;
    const locale = coerceLocale(parsed.locale);
    const article = await createArticle(
      companyId,
      actorUserId,
      { title: { [locale]: parsed.title.trim() }, body: { [locale]: parsed.body.trim() }, status: "draft" }
    );
    return { article, locale };
  } catch (err) {
    console.error("[kb] draft-from-thread failed:", (err as Error).message);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Portal-facing (published only) + AI grounding
// ──────────────────────────────────────────────────────────────────────

function coerceLocale(v: string | undefined): Locale {
  return v && (LOCALES as string[]).includes(v) ? (v as Locale) : "en";
}

/** Localized value with en→ar→tr fallback. */
function pick(t: LocaleText | undefined, locale: Locale): string {
  if (!t) return "";
  return t[locale] || t.en || t.ar || t.tr || "";
}

/** Light Markdown → plain text for snippets/grounding (not a full parser). */
function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface PortalArticleSummary {
  id: string;
  slug: string;
  categoryId: string | null;
  title: string;
  snippet: string;
}
export interface PortalCategory {
  id: string;
  slug: string;
  name: string;
}

/** Browse: published categories + articles, localized to the customer's locale. */
export async function listPublished(
  companyId: string,
  localeIn: string | undefined,
  opts: { q?: string; categoryId?: string } = {}
): Promise<{ categories: PortalCategory[]; articles: PortalArticleSummary[] }> {
  // Downgrade = pure-resolution-lock: no entitlement ⇒ portal help center hidden.
  if (!(await isEnabled(companyId, "knowledge_base"))) return { categories: [], articles: [] };
  const locale = coerceLocale(localeIn);
  const cats = await listCategories(companyId);
  const arts = await listArticles(companyId, {
    status: "published",
    categoryId: opts.categoryId,
    q: opts.q,
  });
  return {
    categories: cats.map((c) => ({ id: c.id, slug: c.slug, name: pick(c.name, locale) || c.slug })),
    articles: arts.map((a) => {
      const body = stripMarkdown(pick(a.body, locale));
      return {
        id: a.id,
        slug: a.slug,
        categoryId: a.categoryId,
        title: pick(a.title, locale) || a.slug,
        snippet: body.slice(0, 160) + (body.length > 160 ? "…" : ""),
      };
    }),
  };
}

export interface PortalArticleFull {
  id: string;
  slug: string;
  categoryId: string | null;
  title: string;
  body: string;
  helpfulYes: number;
  helpfulNo: number;
}

/** Single published article by slug (localized). Increments viewCount. */
export async function getPublishedArticle(
  companyId: string,
  slug: string,
  localeIn: string | undefined
): Promise<PortalArticleFull | null> {
  if (!(await isEnabled(companyId, "knowledge_base"))) return null;
  const locale = coerceLocale(localeIn);
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT ${ART_COLS} FROM kb_articles
       WHERE "companyId" = $1 AND "slug" = $2 AND "status" = 'published' LIMIT 1`,
    companyId,
    slug
  )) as KbArticle[];
  const a = rows[0];
  if (!a) return null;
  await prisma.$executeRawUnsafe(
    `UPDATE kb_articles SET "viewCount" = "viewCount" + 1 WHERE "companyId" = $1 AND "id" = $2`,
    companyId,
    a.id
  );
  return {
    id: a.id,
    slug: a.slug,
    categoryId: a.categoryId,
    title: pick(a.title, locale) || a.slug,
    body: pick(a.body, locale),
    helpfulYes: a.helpfulYes,
    helpfulNo: a.helpfulNo,
  };
}

/** "Was this helpful?" — increments the counter on a published article. */
export async function recordHelpful(companyId: string, id: string, yes: boolean): Promise<boolean> {
  if (!(await isEnabled(companyId, "knowledge_base"))) return false;
  const col = yes ? "helpfulYes" : "helpfulNo";
  const n = await prisma.$executeRawUnsafe(
    `UPDATE kb_articles SET "${col}" = "${col}" + 1
       WHERE "companyId" = $1 AND "id" = $2 AND "status" = 'published'`,
    companyId,
    id
  );
  return Number(n) > 0;
}

/** Count of published articles (drives whether the portal Help surface shows). */
export async function countPublished(companyId: string): Promise<number> {
  if (!(await isEnabled(companyId, "knowledge_base"))) return 0;
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM kb_articles WHERE "companyId" = $1 AND "status" = 'published'`,
    companyId
  )) as Array<{ c: number }>;
  return Number(rows[0]?.c ?? 0);
}

export interface GroundedCitation {
  id: string;
  slug: string;
  title: string;
}
export interface GroundedAnswer {
  grounded: boolean; // true = answered FROM an article
  answer: string | null;
  citations: GroundedCitation[];
}

const GROUND_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    answered: { type: SchemaType.BOOLEAN },
    answer: { type: SchemaType.STRING },
    used: { type: SchemaType.ARRAY, items: { type: SchemaType.INTEGER } },
  },
  required: ["answered", "answer"],
} as const;

const STOPWORDS = new Set([
  "the", "and", "for", "are", "you", "your", "how", "what", "where", "when", "why",
  "can", "with", "this", "that", "from", "have", "does", "did", "was", "will",
]);

/**
 * Answer a portal customer's question STRICTLY from the merchant's published
 * articles (top-k by keyword match v1, token-capped). Cites the article(s)
 * actually used. Returns grounded=false (answer=null) when KB is not entitled,
 * there are no matching articles, or the model can't answer from them — the
 * widget then falls back to current behavior. Never hallucinates.
 */
export async function askGrounded(
  companyId: string,
  localeIn: string | undefined,
  message: string,
  history: { role?: string; text?: string }[] = []
): Promise<GroundedAnswer> {
  const empty: GroundedAnswer = { grounded: false, answer: null, citations: [] };
  if (!message.trim()) return empty;
  if (!genAI) return empty;
  if (!(await isEnabled(companyId, "knowledge_base"))) return empty;

  const locale = coerceLocale(localeIn);
  const published = (await prisma.$queryRawUnsafe(
    `SELECT "id","slug","title","body" FROM kb_articles
       WHERE "companyId" = $1 AND "status" = 'published'`,
    companyId
  )) as Array<{ id: string; slug: string; title: LocaleText; body: LocaleText }>;
  if (published.length === 0) return empty;

  // Simple keyword scoring over localized title+body (title weighted ×3).
  const tokens = message
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  const scored = published
    .map((a) => {
      const title = pick(a.title, locale).toLowerCase();
      const body = stripMarkdown(pick(a.body, locale)).toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (title.includes(t)) score += 3;
        if (body.includes(t)) score += 1;
      }
      return { a, score };
    })
    .filter((s) => s.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, 3);
  if (scored.length === 0) return empty;

  const LANG = { en: "English", ar: "Arabic", tr: "Turkish" }[locale];
  const context = scored
    .map((s, i) => `[Article ${i + 1}: "${pick(s.a.title, locale)}"]\n${pick(s.a.body, locale).slice(0, 1500)}`)
    .join("\n\n");

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction:
      `You are a helpful support assistant for a business. Answer the customer's question ` +
      `using ONLY the help articles provided. Reply ENTIRELY in ${LANG}. Be concise and warm. ` +
      `If the answer is not contained in the articles, set "answered" to false and leave "answer" empty — ` +
      `do NOT use outside knowledge or guess. When you answer, set "used" to the article NUMBERS you relied on. ` +
      `Return STRICT JSON only.`,
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
      responseSchema: GROUND_SCHEMA as never,
    },
  });

  const transcript = history
    .slice(-8)
    .map((h) => `${h.role === "user" ? "CUSTOMER" : "ASSISTANT"}: ${h.text ?? ""}`)
    .join("\n");
  const prompt =
    `HELP ARTICLES:\n${context}\n\n` +
    (transcript ? `CONVERSATION:\n${transcript}\n\n` : "") +
    `CUSTOMER QUESTION: ${message}\n\nAnswer in ${LANG} as JSON {answered, answer, used}.`;

  try {
    const result = await model.generateContent(prompt);
    const parsed = JSON.parse(result.response.text()) as { answered?: boolean; answer?: string; used?: number[] };
    if (!parsed.answered || !parsed.answer?.trim()) return empty;
    const used = Array.isArray(parsed.used) ? parsed.used : [];
    const citations = scored
      .filter((_, i) => used.includes(i + 1))
      .map((s) => ({ id: s.a.id, slug: s.a.slug, title: pick(s.a.title, locale) || s.a.slug }));
    // If the model answered but cited nothing, attribute to the top match.
    if (citations.length === 0) {
      const top = scored[0].a;
      citations.push({ id: top.id, slug: top.slug, title: pick(top.title, locale) || top.slug });
    }
    return { grounded: true, answer: parsed.answer.trim(), citations };
  } catch (err) {
    console.error("[kb] grounded answer failed:", (err as Error).message);
    return empty;
  }
}
