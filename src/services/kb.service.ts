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
