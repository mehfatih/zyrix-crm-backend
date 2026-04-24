import fs from "node:fs";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/database";

// ============================================================================
// DOCS SERVICE — reads markdown from the web project's content/docs directory.
// The markdown is the source of truth; doc_article_meta sits on top of it in
// the database so admins can override status / plans / recently-updated.
//
// DOCS_CONTENT_DIR env overrides the default path used to locate the
// markdown source tree. Falls back to a pre-built docs-index.json bundled
// inside this service's data directory.
// ============================================================================

export type DocLocale = "en" | "ar" | "tr";

export interface DocArticle {
  locale: DocLocale;
  category: string;
  subcategory?: string;
  slug: string;
  path: string;
  title: string;
  plans: string[];
  readTime?: string;
  updatedAt?: string;
  featureNumber?: number;
  order: number;
  body: string;
  plain: string;
  status: string;
  recentlyUpdated: boolean;
}

interface CategoryIndexEntry {
  id: string;
  count: number;
  articles: {
    slug: string;
    title: string;
    order: number;
    readTime?: string;
    updatedAt?: string;
  }[];
}

const DEFAULT_CONTENT_DIRS = [
  process.env.DOCS_CONTENT_DIR,
  path.resolve(process.cwd(), "..", "zyrix-crm", "content", "docs"),
  path.resolve(process.cwd(), "content", "docs"),
].filter(Boolean) as string[];

const FALLBACK_INDEX = path.resolve(
  __dirname,
  "..",
  "data",
  "docsIndex.json"
);

function locateContentDir(): string | null {
  for (const dir of DEFAULT_CONTENT_DIRS) {
    try {
      if (fs.existsSync(dir)) return dir;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function listMarkdown(dir: string, base = ""): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listMarkdown(full, rel));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

function parseFrontmatter(raw: string): { fm: Record<string, unknown>; body: string } {
  if (!raw.startsWith("---")) return { fm: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { fm: {}, body: raw };
  const header = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\n/, "");
  const fm: Record<string, unknown> = {};
  for (const line of header.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (val.startsWith("[") && val.endsWith("]")) {
      fm[key] = val
        .slice(1, -1)
        .split(",")
        .map((x) => x.trim().replace(/^"(.*)"$/, "$1"))
        .filter(Boolean);
      continue;
    }
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (/^-?\d+$/.test(val)) fm[key] = Number(val);
    else if (val === "true" || val === "false") fm[key] = val === "true";
    else fm[key] = val;
  }
  return { fm, body };
}

function stripMd(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]+`/g, " ")
    .replace(/[#*_>`]/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

async function mergeMeta(articles: DocArticle[]): Promise<DocArticle[]> {
  try {
    const keys = articles.map((a) => ({
      locale: a.locale,
      category: a.category,
      slug: a.slug,
    }));
    if (!keys.length) return articles;
    const metas = await prisma.docArticleMeta.findMany({
      where: { OR: keys },
    });
    if (!metas.length) return articles;
    const index = new Map<string, (typeof metas)[number]>();
    for (const m of metas) index.set(`${m.locale}:${m.category}:${m.slug}`, m);
    return articles.map((a) => {
      const key = `${a.locale}:${a.category}:${a.slug}`;
      const m = index.get(key);
      if (!m) return a;
      return {
        ...a,
        title: m.title || a.title,
        plans: (m.plansJson as string[] | null) ?? a.plans,
        status: m.status,
        recentlyUpdated: m.recentlyUpdated,
      };
    });
  } catch {
    return articles;
  }
}

let CACHED: Map<DocLocale, DocArticle[]> | null = null;

async function readAll(force = false): Promise<Map<DocLocale, DocArticle[]>> {
  if (CACHED && !force) return CACHED;
  const dir = locateContentDir();
  const byLocale = new Map<DocLocale, DocArticle[]>();

  if (dir) {
    for (const locale of ["en", "ar", "tr"] as DocLocale[]) {
      const root = path.join(dir, locale);
      if (!fs.existsSync(root)) continue;
      const files = listMarkdown(root);
      const articles: DocArticle[] = [];
      for (const rel of files) {
        const full = path.join(root, rel);
        const raw = fs.readFileSync(full, "utf8");
        const { fm, body } = parseFrontmatter(raw);
        const withoutExt = rel.replace(/\.md$/, "");
        const parts = withoutExt.split("/");
        let category: string;
        let subcategory: string | undefined;
        let slug: string;
        if (parts[0] === "features" && parts.length >= 3) {
          category = parts[1];
          slug = parts[parts.length - 1];
          if (parts.length > 3) subcategory = parts.slice(1, -1).join("/");
        } else if (parts.length === 1) {
          category = (fm.category as string) || "overview";
          slug = parts[0].replace(/^\d+-/, "");
        } else {
          category = parts[0];
          slug = parts[parts.length - 1];
        }
        articles.push({
          locale,
          category: (fm.category as string) || category,
          subcategory,
          slug: (fm.slug as string) || slug,
          path: withoutExt,
          title: (fm.title as string) || slug,
          plans: (fm.plans as string[] | undefined) ?? [],
          readTime: fm.readTime as string | undefined,
          updatedAt: fm.updatedAt as string | undefined,
          featureNumber: fm.featureNumber as number | undefined,
          order: (fm.order as number | undefined) ?? 999,
          body,
          plain: stripMd(body),
          status: "published",
          recentlyUpdated: false,
        });
      }
      articles.sort(
        (a, b) => a.category.localeCompare(b.category) || a.order - b.order
      );
      byLocale.set(locale, await mergeMeta(articles));
    }
  } else if (fs.existsSync(FALLBACK_INDEX)) {
    try {
      const raw = JSON.parse(fs.readFileSync(FALLBACK_INDEX, "utf8")) as Record<
        string,
        DocArticle[]
      >;
      for (const [locale, list] of Object.entries(raw)) {
        byLocale.set(
          locale as DocLocale,
          await mergeMeta(list.map((a) => ({ ...a })))
        );
      }
    } catch {
      /* corrupt bundle — skip */
    }
  }

  CACHED = byLocale;
  return byLocale;
}

export function invalidateDocsCache() {
  CACHED = null;
}

export async function getIndex(locale: DocLocale): Promise<{
  categories: CategoryIndexEntry[];
  total: number;
}> {
  const all = (await readAll()).get(locale) || [];
  const byCat = new Map<string, DocArticle[]>();
  for (const a of all) {
    if (a.status !== "published") continue;
    if (!byCat.has(a.category)) byCat.set(a.category, []);
    byCat.get(a.category)!.push(a);
  }
  const categories: CategoryIndexEntry[] = [];
  for (const [id, list] of byCat.entries()) {
    categories.push({
      id,
      count: list.length,
      articles: list
        .sort((a, b) => a.order - b.order)
        .map((a) => ({
          slug: a.slug,
          title: a.title,
          order: a.order,
          readTime: a.readTime,
          updatedAt: a.updatedAt,
        })),
    });
  }
  categories.sort((a, b) => a.id.localeCompare(b.id));
  return { categories, total: all.length };
}

export async function getCategory(
  locale: DocLocale,
  category: string
): Promise<DocArticle[]> {
  const all = (await readAll()).get(locale) || [];
  return all
    .filter((a) => a.category === category && a.status === "published")
    .sort((a, b) => a.order - b.order);
}

export async function getArticle(
  locale: DocLocale,
  category: string,
  slug: string
): Promise<DocArticle | null> {
  const all = (await readAll()).get(locale) || [];
  return (
    all.find(
      (a) =>
        a.category === category &&
        a.slug === slug &&
        a.status === "published"
    ) || null
  );
}

export async function searchDocs(
  locale: DocLocale,
  query: string,
  limit = 20
): Promise<
  Array<{
    category: string;
    slug: string;
    title: string;
    path: string;
    snippet: string;
  }>
> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const all = (await readAll()).get(locale) || [];
  const hits: {
    category: string;
    slug: string;
    title: string;
    path: string;
    snippet: string;
    score: number;
  }[] = [];
  for (const a of all) {
    if (a.status !== "published") continue;
    const titleHit = a.title.toLowerCase().includes(q);
    const bodyHit = a.plain.toLowerCase().includes(q);
    if (!titleHit && !bodyHit) continue;
    const idx = a.plain.toLowerCase().indexOf(q);
    const snippetStart = Math.max(0, idx - 80);
    const snippet = a.plain
      .slice(snippetStart, snippetStart + 200)
      .trim();
    hits.push({
      category: a.category,
      slug: a.slug,
      title: a.title,
      path: a.path,
      snippet: idx > 0 ? `…${snippet}…` : `${snippet}…`,
      score: (titleHit ? 10 : 0) + (bodyHit ? 1 : 0),
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit).map(({ score: _s, ...rest }) => rest);
}

export async function recordFeedback({
  locale,
  category,
  slug,
  helpful,
  comment,
}: {
  locale: DocLocale;
  category: string;
  slug: string;
  helpful: boolean;
  comment?: string;
}) {
  try {
    await prisma.docEvent.create({
      data: {
        eventType: "helpful",
        locale,
        category,
        slug,
        helpful,
        metadata: comment ? { comment } : {},
      },
    });
  } catch {
    /* telemetry is best-effort */
  }
}

export async function recordEvent(input: {
  eventType: "view" | "dwell" | "search";
  locale: DocLocale;
  category?: string;
  slug?: string;
  query?: string;
  durationSeconds?: number;
  metadata?: Record<string, unknown>;
}) {
  try {
    await prisma.docEvent.create({
      data: {
        eventType: input.eventType,
        locale: input.locale,
        category: input.category,
        slug: input.slug,
        query: input.query,
        durationSeconds: input.durationSeconds,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  } catch {
    /* telemetry best-effort */
  }
}

// ────────────────────────────────────────────────────────────────────────
// Admin analytics helpers — used by the admin panel dashboard
// ────────────────────────────────────────────────────────────────────────
export async function getTopArticles(days = 7, limit = 10) {
  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await prisma.docEvent.groupBy({
      by: ["locale", "category", "slug"],
      where: {
        eventType: "view",
        createdAt: { gte: since },
        category: { not: null },
        slug: { not: null },
      },
      _count: { _all: true },
      orderBy: { _count: { id: "desc" } },
      take: limit,
    });
    return rows.map((r) => ({
      locale: r.locale,
      category: r.category,
      slug: r.slug,
      views: r._count._all,
    }));
  } catch {
    return [];
  }
}

export async function getTopSearches(days = 7, limit = 20) {
  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await prisma.docEvent.groupBy({
      by: ["query", "locale"],
      where: {
        eventType: "search",
        createdAt: { gte: since },
        query: { not: null },
      },
      _count: { _all: true },
      orderBy: { _count: { id: "desc" } },
      take: limit,
    });
    return rows.map((r) => ({
      locale: r.locale,
      query: r.query,
      count: r._count._all,
    }));
  } catch {
    return [];
  }
}

export async function getUnhelpfulArticles(days = 30, limit = 10) {
  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await prisma.docEvent.findMany({
      where: {
        eventType: "helpful",
        helpful: false,
        createdAt: { gte: since },
      },
      select: { locale: true, category: true, slug: true },
    });
    const tally = new Map<string, { locale: string; category: string; slug: string; count: number }>();
    for (const r of rows) {
      if (!r.category || !r.slug) continue;
      const key = `${r.locale}:${r.category}:${r.slug}`;
      const current = tally.get(key);
      if (current) current.count++;
      else
        tally.set(key, {
          locale: r.locale,
          category: r.category,
          slug: r.slug,
          count: 1,
        });
    }
    return Array.from(tally.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  } catch {
    return [];
  }
}

export async function getArticleStats(locale: string, category: string, slug: string) {
  try {
    const [views, helpful, unhelpful] = await Promise.all([
      prisma.docEvent.count({
        where: { eventType: "view", locale, category, slug },
      }),
      prisma.docEvent.count({
        where: { eventType: "helpful", locale, category, slug, helpful: true },
      }),
      prisma.docEvent.count({
        where: { eventType: "helpful", locale, category, slug, helpful: false },
      }),
    ]);
    return { views, helpful, unhelpful };
  } catch {
    return { views: 0, helpful: 0, unhelpful: 0 };
  }
}

export async function upsertArticleMeta(input: {
  locale: string;
  category: string;
  slug: string;
  title?: string;
  plans?: string[];
  status?: "draft" | "published";
  recentlyUpdated?: boolean;
  internalNotes?: string;
  updatedByUserId?: string;
}) {
  const { locale, category, slug } = input;
  await prisma.docArticleMeta.upsert({
    where: { locale_category_slug: { locale, category, slug } },
    create: {
      locale,
      category,
      slug,
      title: input.title,
      plansJson: input.plans ?? undefined,
      status: input.status ?? "published",
      recentlyUpdated: input.recentlyUpdated ?? false,
      internalNotes: input.internalNotes,
      updatedByUserId: input.updatedByUserId,
    },
    update: {
      title: input.title,
      plansJson: input.plans ?? undefined,
      status: input.status,
      recentlyUpdated: input.recentlyUpdated,
      internalNotes: input.internalNotes,
      updatedByUserId: input.updatedByUserId,
    },
  });
  invalidateDocsCache();
}

export async function listAllArticlesForAdmin() {
  const byLocale = await readAll();
  const out: Array<DocArticle & { stats?: { views: number; helpful: number; unhelpful: number } }> = [];
  for (const list of byLocale.values()) {
    for (const a of list) out.push(a);
  }
  return out;
}
