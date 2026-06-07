// ============================================================================
// LANDING PAGES — PAGE MODEL + PUBLIC RENDER (raw SQL) — Sprint 20
// ----------------------------------------------------------------------------
// Tenant-scoped (companyId). Single-locale per page. Raw-SQL tables
// (landing_pages, landing_page_events), relation-free — accessed via
// $queryRawUnsafe, mirroring the Sprint 18/19 tickets + KB pattern. Gated by
// the `landing_pages` entitlement (LIMIT feature: starter 1 / business+ ∞).
//
// Phase A: merchant CRUD + publish + public render (the /p/:companySlug/:pageSlug
// payload, with the chosen Sprint-12 form + product blocks resolved). The
// builder UI + AI copy land in Phase B; the landing-tagged submit + conversion
// counters land in Phase C.
// ============================================================================

import { randomUUID } from "crypto";
import { prisma } from "../config/database";
import { isEnabled } from "./entitlements.service";
import type { FormStep, FlowTheme } from "./form-flows.service";

export const PAGE_STATUSES = ["draft", "published"] as const;
export type PageStatus = (typeof PAGE_STATUSES)[number];

// A block is a small ordered unit: { id, type, props }. Props are block-specific
// and stored verbatim as JSONB; the renderer knows each shape. Kept loose on
// purpose (simplicity over a rigid per-block schema for v1).
export const BLOCK_TYPES = [
  "hero",
  "benefits",
  "product",
  "testimonials",
  "faq",
  "form",
  "footer",
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

export interface LandingBlock {
  id: string;
  type: BlockType;
  props: Record<string, unknown>;
}

export interface LandingTheme {
  primaryColor?: string;
  accentColor?: string;
  logoUrl?: string;
  font?: string;
}

export interface LandingPage {
  id: string;
  companyId: string;
  slug: string;
  status: string;
  locale: string;
  title: string;
  blocks: LandingBlock[];
  theme: LandingTheme;
  metaPixelId: string | null;
  formId: string | null;
  viewCount: number;
  submitCount: number;
  createdById: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base || `page-${randomUUID().slice(0, 8)}`;
}

async function uniqueSlug(companyId: string, desired: string, ignoreId?: string): Promise<string> {
  let slug = desired;
  for (let i = 0; i < 50; i++) {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT "id" FROM landing_pages WHERE "companyId" = $1 AND "slug" = $2 LIMIT 1`,
      companyId,
      slug
    )) as Array<{ id: string }>;
    if (!rows[0] || (ignoreId && rows[0].id === ignoreId)) return slug;
    slug = `${desired}-${i + 2}`;
  }
  return `${desired}-${randomUUID().slice(0, 6)}`;
}

/** Coerce arbitrary JSON into a clean ordered block array (drops unknown types). */
function cleanBlocks(v: unknown): LandingBlock[] {
  if (!Array.isArray(v)) return [];
  const out: LandingBlock[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as Record<string, unknown>;
    if (!(BLOCK_TYPES as readonly string[]).includes(String(b.type))) continue;
    out.push({
      id: typeof b.id === "string" && b.id ? b.id : randomUUID(),
      type: b.type as BlockType,
      props: b.props && typeof b.props === "object" && !Array.isArray(b.props) ? (b.props as Record<string, unknown>) : {},
    });
  }
  return out;
}

function cleanTheme(v: unknown): LandingTheme {
  const out: LandingTheme = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const t = v as Record<string, unknown>;
    if (typeof t.primaryColor === "string") out.primaryColor = t.primaryColor;
    if (typeof t.accentColor === "string") out.accentColor = t.accentColor;
    if (typeof t.logoUrl === "string") out.logoUrl = t.logoUrl;
    if (typeof t.font === "string") out.font = t.font;
  }
  return out;
}

function coerceLocale(v: unknown): string {
  return v === "ar" || v === "en" || v === "tr" ? v : "ar";
}

const COLS = `
  "id","companyId","slug","status","locale","title","blocks","theme",
  "metaPixelId","formId","viewCount","submitCount","createdById",
  "publishedAt","createdAt","updatedAt"
`;

// ──────────────────────────────────────────────────────────────────────
// Merchant CRUD
// ──────────────────────────────────────────────────────────────────────

export async function listPages(companyId: string): Promise<LandingPage[]> {
  return (await prisma.$queryRawUnsafe(
    `SELECT ${COLS} FROM landing_pages WHERE "companyId" = $1 ORDER BY "updatedAt" DESC`,
    companyId
  )) as LandingPage[];
}

export async function getPage(companyId: string, id: string): Promise<LandingPage | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT ${COLS} FROM landing_pages WHERE "companyId" = $1 AND "id" = $2 LIMIT 1`,
    companyId,
    id
  )) as LandingPage[];
  return rows[0] ?? null;
}

/** Current page count for the company (drives enforceLimit). */
export async function countPages(companyId: string): Promise<number> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM landing_pages WHERE "companyId" = $1`,
    companyId
  )) as Array<{ c: number }>;
  return Number(rows[0]?.c ?? 0);
}

export interface PageInput {
  title?: string;
  slug?: string;
  locale?: string;
  blocks?: unknown;
  theme?: unknown;
  metaPixelId?: string | null;
  formId?: string | null;
  status?: string;
}

export async function createPage(
  companyId: string,
  createdById: string | null,
  input: PageInput
): Promise<LandingPage> {
  const id = randomUUID();
  const title = (input.title ?? "").trim();
  const locale = coerceLocale(input.locale);
  const blocks = cleanBlocks(input.blocks);
  const theme = cleanTheme(input.theme);
  const status = (PAGE_STATUSES as readonly string[]).includes(input.status ?? "")
    ? (input.status as string)
    : "draft";
  const slug = await uniqueSlug(companyId, slugify(input.slug || title));
  const publishedAt = status === "published" ? new Date() : null;
  await prisma.$executeRawUnsafe(
    `INSERT INTO landing_pages
       ("id","companyId","slug","status","locale","title","blocks","theme",
        "metaPixelId","formId","viewCount","submitCount","createdById",
        "publishedAt","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,0,0,$11,$12,NOW(),NOW())`,
    id,
    companyId,
    slug,
    status,
    locale,
    title,
    JSON.stringify(blocks),
    JSON.stringify(theme),
    input.metaPixelId ?? null,
    input.formId ?? null,
    createdById,
    publishedAt
  );
  return (await getPage(companyId, id))!;
}

export async function updatePage(
  companyId: string,
  id: string,
  patch: PageInput
): Promise<LandingPage | null> {
  const current = await getPage(companyId, id);
  if (!current) return null;

  const title = patch.title !== undefined ? patch.title.trim() : current.title;
  const locale = patch.locale !== undefined ? coerceLocale(patch.locale) : current.locale;
  const blocks = patch.blocks !== undefined ? cleanBlocks(patch.blocks) : current.blocks;
  const theme = patch.theme !== undefined ? cleanTheme(patch.theme) : current.theme;
  const metaPixelId = patch.metaPixelId !== undefined ? patch.metaPixelId : current.metaPixelId;
  const formId = patch.formId !== undefined ? patch.formId : current.formId;
  const status =
    patch.status !== undefined && (PAGE_STATUSES as readonly string[]).includes(patch.status)
      ? patch.status
      : current.status;
  // Stamp publishedAt on the first transition to published; keep otherwise.
  const publishedAt =
    status === "published" && !current.publishedAt ? new Date() : current.publishedAt;

  let slug = current.slug;
  if (patch.slug !== undefined && patch.slug.trim()) {
    slug = await uniqueSlug(companyId, slugify(patch.slug), id);
  }

  await prisma.$executeRawUnsafe(
    `UPDATE landing_pages
       SET "slug" = $3, "status" = $4, "locale" = $5, "title" = $6,
           "blocks" = $7::jsonb, "theme" = $8::jsonb, "metaPixelId" = $9,
           "formId" = $10, "publishedAt" = $11, "updatedAt" = NOW()
     WHERE "companyId" = $1 AND "id" = $2`,
    companyId,
    id,
    slug,
    status,
    locale,
    title,
    JSON.stringify(blocks),
    JSON.stringify(theme),
    metaPixelId ?? null,
    formId ?? null,
    publishedAt
  );
  return (await getPage(companyId, id))!;
}

export async function deletePage(companyId: string, id: string): Promise<boolean> {
  await prisma.$executeRawUnsafe(
    `DELETE FROM landing_page_events WHERE "companyId" = $1 AND "landingPageId" = $2`,
    companyId,
    id
  );
  const n = await prisma.$executeRawUnsafe(
    `DELETE FROM landing_pages WHERE "companyId" = $1 AND "id" = $2`,
    companyId,
    id
  );
  return Number(n) > 0;
}

/** One-click publish / unpublish. Returns the updated page (or null if absent). */
export async function setPublished(
  companyId: string,
  id: string,
  published: boolean
): Promise<LandingPage | null> {
  return updatePage(companyId, id, { status: published ? "published" : "draft" });
}

// ──────────────────────────────────────────────────────────────────────
// Public render — /p/:companySlug/:pageSlug
// ──────────────────────────────────────────────────────────────────────

export interface PublicProduct {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  imageUrl: string | null;
}

export interface PublicForm {
  token: string;
  name: string;
  steps: FormStep[];
  theme: FlowTheme | null;
}

export interface PublicLandingPage {
  id: string;
  slug: string;
  locale: string;
  title: string;
  blocks: LandingBlock[];
  theme: LandingTheme;
  metaPixelId: string | null;
  companyName: string;
  form: PublicForm | null;
  products: Record<string, PublicProduct>;
}

/** Collect product ids referenced by product blocks. */
function productIdsFromBlocks(blocks: LandingBlock[]): string[] {
  const ids = new Set<string>();
  for (const b of blocks) {
    if (b.type === "product" && typeof b.props.productId === "string" && b.props.productId) {
      ids.add(b.props.productId);
    }
  }
  return [...ids];
}

function parseJson<T>(v: unknown, fb: T): T {
  if (v == null) return fb;
  if (typeof v === "object") return v as T;
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return fb;
  }
}

/**
 * Resolve a published page for public rendering, by company slug + page slug.
 * Gated by the `landing_pages` entitlement (pure-resolution-lock, mirroring KB):
 * if the merchant isn't entitled, the page reads as not found. Resolves the
 * chosen Sprint-12 form (active+public only) and any product blocks. Does NOT
 * record the view — call recordView() separately so a HEAD/prefetch can't inflate.
 */
export async function getPublicPage(
  companySlug: string,
  pageSlug: string
): Promise<PublicLandingPage | null> {
  const companies = (await prisma.$queryRawUnsafe(
    `SELECT "id","name" FROM companies WHERE "slug" = $1 LIMIT 1`,
    companySlug
  )) as Array<{ id: string; name: string }>;
  const company = companies[0];
  if (!company) return null;

  if (!(await isEnabled(company.id, "landing_pages"))) return null;

  const rows = (await prisma.$queryRawUnsafe(
    `SELECT ${COLS} FROM landing_pages
       WHERE "companyId" = $1 AND "slug" = $2 AND "status" = 'published' LIMIT 1`,
    company.id,
    pageSlug
  )) as LandingPage[];
  const page = rows[0];
  if (!page) return null;

  const blocks = page.blocks;

  // Resolve the CTA form (active + public flows only — same gate as /api/f).
  let form: PublicForm | null = null;
  if (page.formId) {
    const flows = (await prisma.$queryRawUnsafe(
      `SELECT "id","name","steps","theme","publicToken"
         FROM form_flows
        WHERE "companyId" = $1 AND "id" = $2 AND "status" = 'active' AND "mode" = 'public' LIMIT 1`,
      company.id,
      page.formId
    )) as Array<{ id: string; name: string; steps: string; theme: string | null; publicToken: string | null }>;
    const flow = flows[0];
    if (flow?.publicToken) {
      form = {
        token: flow.publicToken,
        name: flow.name,
        steps: parseJson<FormStep[]>(flow.steps, []),
        theme: flow.theme ? parseJson<FlowTheme>(flow.theme, {} as FlowTheme) : null,
      };
    }
  }

  // Resolve referenced products (price auto-pulled).
  const products: Record<string, PublicProduct> = {};
  const ids = productIdsFromBlocks(blocks);
  if (ids.length) {
    const placeholders = ids.map((_, i) => `$${i + 2}`).join(",");
    const prows = (await prisma.$queryRawUnsafe(
      `SELECT "id","name","description","price"::text AS "price","currency","imageUrl"
         FROM products WHERE "companyId" = $1 AND "id" IN (${placeholders})`,
      company.id,
      ...ids
    )) as Array<{ id: string; name: string; description: string | null; price: string | null; currency: string | null; imageUrl: string | null }>;
    for (const p of prows) {
      products[p.id] = {
        id: p.id,
        name: p.name,
        description: p.description,
        price: p.price == null ? 0 : Number(p.price),
        currency: p.currency || "USD",
        imageUrl: p.imageUrl,
      };
    }
  }

  return {
    id: page.id,
    slug: page.slug,
    locale: page.locale,
    title: page.title,
    blocks,
    theme: page.theme,
    metaPixelId: page.metaPixelId,
    companyName: company.name,
    form,
    products,
  };
}

/**
 * Beacon path: resolve a published+entitled page by slugs and record one view.
 * No-op (returns false) when the company/page isn't found or isn't entitled.
 */
export async function recordViewBySlug(companySlug: string, pageSlug: string): Promise<boolean> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT lp."id" AS "pageId", c."id" AS "companyId"
       FROM landing_pages lp
       JOIN companies c ON c."id" = lp."companyId"
      WHERE c."slug" = $1 AND lp."slug" = $2 AND lp."status" = 'published' LIMIT 1`,
    companySlug,
    pageSlug
  )) as Array<{ pageId: string; companyId: string }>;
  const ref = rows[0];
  if (!ref) return false;
  if (!(await isEnabled(ref.companyId, "landing_pages"))) return false;
  await recordView(ref.companyId, ref.pageId);
  return true;
}

/** Record a view: time-series row + fast denormalized counter. */
export async function recordView(companyId: string, landingPageId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO landing_page_events ("id","companyId","landingPageId","type","createdAt")
     VALUES ($1,$2,$3,'view',NOW())`,
    randomUUID(),
    companyId,
    landingPageId
  );
  await prisma.$executeRawUnsafe(
    `UPDATE landing_pages SET "viewCount" = "viewCount" + 1 WHERE "id" = $1`,
    landingPageId
  );
}
