import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import * as Kb from "../services/kb.service";

// ============================================================================
// KNOWLEDGE BASE CONTROLLER (/api/knowledge-base, session auth) — Sprint 19
// Read = any authenticated user; build/mutate = owner/admin/manager (router).
// ============================================================================

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId, role: r.user.role };
}

const localeText = z
  .object({
    en: z.string().max(20000).optional(),
    ar: z.string().max(20000).optional(),
    tr: z.string().max(20000).optional(),
  })
  .strict();

// ── Categories ─────────────────────────────────────────────────────────────
export async function listCategories(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await Kb.listCategories(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

const categorySchema = z.object({
  name: localeText,
  sortOrder: z.number().int().optional(),
});

export async function createCategory(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = categorySchema.parse(req.body);
    const data = await Kb.createCategory(companyId, dto);
    res.status(201).json({ success: true, data });
  } catch (err) { next(err); }
}

export async function updateCategory(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = categorySchema.partial().parse(req.body);
    const data = await Kb.updateCategory(companyId, String(req.params.id), dto);
    if (!data) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Category not found" } });
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

export async function deleteCategory(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const ok = await Kb.deleteCategory(companyId, String(req.params.id));
    if (!ok) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Category not found" } });
    res.status(200).json({ success: true });
  } catch (err) { next(err); }
}

// ── Articles ─────────────────────────────────────────────────────────────
export async function listArticles(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const q = req.query;
    const data = await Kb.listArticles(companyId, {
      status: typeof q.status === "string" ? q.status : undefined,
      categoryId: typeof q.categoryId === "string" ? q.categoryId : undefined,
      q: typeof q.q === "string" ? q.q : undefined,
    });
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

export async function getArticle(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await Kb.getArticle(companyId, String(req.params.id));
    if (!data) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Article not found" } });
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

const articleSchema = z.object({
  title: localeText,
  body: localeText,
  categoryId: z.string().uuid().nullable().optional(),
  status: z.enum(["draft", "published"]).optional(),
  slug: z.string().max(80).optional(),
});

export async function createArticle(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const dto = articleSchema.parse(req.body);
    const data = await Kb.createArticle(companyId, userId, dto);
    res.status(201).json({ success: true, data });
  } catch (err) { next(err); }
}

export async function updateArticle(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = articleSchema.partial().parse(req.body);
    const data = await Kb.updateArticle(companyId, String(req.params.id), dto);
    if (!data) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Article not found" } });
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

export async function deleteArticle(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const ok = await Kb.deleteArticle(companyId, String(req.params.id));
    if (!ok) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Article not found" } });
    res.status(200).json({ success: true });
  } catch (err) { next(err); }
}

// ── AI assist — translate to the other two languages ──────────────────────
const translateSchema = z.object({
  sourceLocale: z.enum(["en", "ar", "tr"]),
  title: z.string().min(1).max(20000),
  body: z.string().max(40000),
});

export async function translate(req: Request, res: Response, next: NextFunction) {
  try {
    const dto = translateSchema.parse(req.body);
    const data = await Kb.translateArticle(dto.sourceLocale, dto.title, dto.body);
    if (!data) {
      return res.status(503).json({
        success: false,
        error: { code: "AI_UNAVAILABLE", message: "Translation is unavailable right now." },
      });
    }
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}
