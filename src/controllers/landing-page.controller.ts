import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import * as Lp from "../services/landing-page.service";
import * as LpAi from "../services/landing-ai.service";

// ============================================================================
// LANDING PAGES CONTROLLER (/api/landing-pages, session auth) — Sprint 20
// Read = any authenticated user; build/mutate = owner/admin/manager (router).
// Public render lives in landing-public.controller (no auth).
// ============================================================================

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId, role: r.user.role };
}

const themeSchema = z
  .object({
    primaryColor: z.string().max(32).optional(),
    accentColor: z.string().max(32).optional(),
    logoUrl: z.string().max(2000).optional(),
    font: z.string().max(64).optional(),
  })
  .strict();

// Blocks are kept loose on purpose (v1): an ordered array of {id?,type,props}.
// The service re-validates types + shape; here we just bound the size.
const blockSchema = z.object({
  id: z.string().max(64).optional(),
  type: z.enum(Lp.BLOCK_TYPES),
  props: z.record(z.unknown()).optional(),
});

const pageSchema = z.object({
  title: z.string().max(200).optional(),
  slug: z.string().max(80).optional(),
  locale: z.enum(["en", "ar", "tr"]).optional(),
  blocks: z.array(blockSchema).max(50).optional(),
  theme: themeSchema.optional(),
  metaPixelId: z.string().max(64).nullable().optional(),
  formId: z.string().uuid().nullable().optional(),
  status: z.enum(["draft", "published"]).optional(),
});

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await Lp.listPages(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

export async function getOne(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await Lp.getPage(companyId, String(req.params.id));
    if (!data) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Landing page not found" } });
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const dto = pageSchema.parse(req.body);
    const data = await Lp.createPage(companyId, userId, dto);
    res.status(201).json({ success: true, data });
  } catch (err) { next(err); }
}

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = pageSchema.partial().parse(req.body);
    const data = await Lp.updatePage(companyId, String(req.params.id), dto);
    if (!data) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Landing page not found" } });
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const ok = await Lp.deletePage(companyId, String(req.params.id));
    if (!ok) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Landing page not found" } });
    res.status(200).json({ success: true });
  } catch (err) { next(err); }
}

// ── AI copy generation ─────────────────────────────────────────────────────
const generateSchema = z.object({ prompt: z.string().min(1).max(600) });
const generateBlockSchema = z.object({ blockId: z.string().min(1).max(64), prompt: z.string().min(1).max(600) });

function aiUnavailable(res: Response) {
  return res.status(503).json({
    success: false,
    error: { code: "AI_UNAVAILABLE", message: "Copy generation is unavailable right now." },
  });
}

export async function generate(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const { prompt } = generateSchema.parse(req.body);
    const page = await Lp.getPage(companyId, String(req.params.id));
    if (!page) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Landing page not found" } });
    const blocks = await LpAi.generatePageCopy(companyId, page, prompt);
    if (!blocks) return aiUnavailable(res);
    res.status(200).json({ success: true, data: { blocks } });
  } catch (err) { next(err); }
}

export async function generateBlock(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const { blockId, prompt } = generateBlockSchema.parse(req.body);
    const page = await Lp.getPage(companyId, String(req.params.id));
    if (!page) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Landing page not found" } });
    const block = await LpAi.generateBlockCopy(companyId, page, blockId, prompt);
    if (!block) return aiUnavailable(res);
    res.status(200).json({ success: true, data: { block } });
  } catch (err) { next(err); }
}

const publishSchema = z.object({ published: z.boolean() });

export async function setPublished(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const { published } = publishSchema.parse(req.body);
    const data = await Lp.setPublished(companyId, String(req.params.id), published);
    if (!data) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Landing page not found" } });
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}
