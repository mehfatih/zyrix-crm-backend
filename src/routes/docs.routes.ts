import { Router, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import {
  getIndex,
  getCategory,
  getArticle,
  searchDocs,
  recordEvent,
  recordFeedback,
  getTopArticles,
  getTopSearches,
  getUnhelpfulArticles,
  getArticleStats,
  upsertArticleMeta,
  listAllArticlesForAdmin,
  type DocLocale,
} from "../services/docs.service";
import { requireSuperAdmin } from "../middleware/superAdmin";

// ============================================================================
// /api/docs — public read endpoints + feedback/analytics write endpoints.
// Admin analytics live behind super admin auth under /api/admin/docs.
// ============================================================================

const router = Router();

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

function parseLocale(raw: unknown): DocLocale | null {
  if (raw === "en" || raw === "ar" || raw === "tr") return raw;
  return null;
}

function param(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return "";
}

router.get(
  "/:lang/index",
  readLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const locale = parseLocale(param(req.params.lang));
      if (!locale) {
        res.status(400).json({ success: false, error: { code: "BAD_LOCALE" } });
        return;
      }
      const data = await getIndex(locale);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/:lang/search",
  readLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const locale = parseLocale(param(req.params.lang));
      if (!locale) {
        res.status(400).json({ success: false, error: { code: "BAD_LOCALE" } });
        return;
      }
      const query = String(req.query.q || "").trim();
      const limit = Math.min(50, Number(req.query.limit) || 20);
      const results = await searchDocs(locale, query, limit);
      // Fire-and-forget telemetry
      if (query) {
        recordEvent({ eventType: "search", locale, query }).catch(() => undefined);
      }
      res.json({ success: true, data: { query, results } });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/:lang/:category",
  readLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const locale = parseLocale(param(req.params.lang));
      if (!locale) {
        res.status(400).json({ success: false, error: { code: "BAD_LOCALE" } });
        return;
      }
      const articles = await getCategory(locale, param(req.params.category));
      if (!articles.length) {
        res.status(404).json({ success: false, error: { code: "NOT_FOUND" } });
        return;
      }
      res.json({
        success: true,
        data: {
          category: param(req.params.category),
          articles: articles.map((a) => ({
            slug: a.slug,
            title: a.title,
            order: a.order,
            readTime: a.readTime,
            plans: a.plans,
            updatedAt: a.updatedAt,
            recentlyUpdated: a.recentlyUpdated,
          })),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/:lang/:category/:slug",
  readLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const locale = parseLocale(param(req.params.lang));
      if (!locale) {
        res.status(400).json({ success: false, error: { code: "BAD_LOCALE" } });
        return;
      }
      const article = await getArticle(
        locale,
        param(req.params.category),
        param(req.params.slug)
      );
      if (!article) {
        res.status(404).json({ success: false, error: { code: "NOT_FOUND" } });
        return;
      }
      // Best-effort view telemetry
      recordEvent({
        eventType: "view",
        locale,
        category: param(req.params.category),
        slug: param(req.params.slug),
      }).catch(() => undefined);
      res.json({
        success: true,
        data: {
          locale: article.locale,
          category: article.category,
          slug: article.slug,
          title: article.title,
          plans: article.plans,
          readTime: article.readTime,
          updatedAt: article.updatedAt,
          featureNumber: article.featureNumber,
          body: article.body,
          path: article.path,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

const feedbackSchema = z.object({
  locale: z.enum(["en", "ar", "tr"]),
  category: z.string().min(1).max(60),
  articleSlug: z.string().min(1).max(120),
  helpful: z.boolean(),
  comment: z.string().max(1000).optional(),
});

router.post(
  "/feedback",
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = feedbackSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: { code: "VALIDATION_ERROR", details: parsed.error.issues },
        });
        return;
      }
      await recordFeedback({
        locale: parsed.data.locale,
        category: parsed.data.category,
        slug: parsed.data.articleSlug,
        helpful: parsed.data.helpful,
        comment: parsed.data.comment,
      });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }
);

const analyticsSchema = z.object({
  event: z.enum(["view", "dwell", "search"]),
  locale: z.enum(["en", "ar", "tr"]),
  category: z.string().optional(),
  slug: z.string().optional(),
  query: z.string().optional(),
  seconds: z.number().int().min(0).max(24 * 60 * 60).optional(),
});

router.post(
  "/analytics",
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = analyticsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR" } });
        return;
      }
      await recordEvent({
        eventType: parsed.data.event,
        locale: parsed.data.locale,
        category: parsed.data.category,
        slug: parsed.data.slug,
        query: parsed.data.query,
        durationSeconds: parsed.data.seconds,
      });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }
);

// ────────────────────────────────────────────────────────────────────────
// Admin-only endpoints (super admin auth)
// Mount at /api/admin/docs via index.ts.
// ────────────────────────────────────────────────────────────────────────
export const adminDocsRouter = Router();

adminDocsRouter.get(
  "/overview",
  requireSuperAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const days = Math.min(365, Number(req.query.days) || 7);
      const [top, searches, unhelpful] = await Promise.all([
        getTopArticles(days, 10),
        getTopSearches(days, 20),
        getUnhelpfulArticles(30, 10),
      ]);
      res.json({
        success: true,
        data: { days, topArticles: top, topSearches: searches, unhelpful },
      });
    } catch (err) {
      next(err);
    }
  }
);

adminDocsRouter.get(
  "/articles",
  requireSuperAdmin,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const articles = await listAllArticlesForAdmin();
      res.json({
        success: true,
        data: articles.map((a) => ({
          locale: a.locale,
          category: a.category,
          slug: a.slug,
          title: a.title,
          status: a.status,
          plans: a.plans,
          recentlyUpdated: a.recentlyUpdated,
          updatedAt: a.updatedAt,
          readTime: a.readTime,
          path: a.path,
        })),
      });
    } catch (err) {
      next(err);
    }
  }
);

adminDocsRouter.get(
  "/articles/:locale/:category/:slug/stats",
  requireSuperAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const stats = await getArticleStats(
        param(req.params.locale),
        param(req.params.category),
        param(req.params.slug)
      );
      res.json({ success: true, data: stats });
    } catch (err) {
      next(err);
    }
  }
);

const metaPatchSchema = z.object({
  title: z.string().max(300).optional(),
  plans: z.array(z.string()).max(10).optional(),
  status: z.enum(["draft", "published"]).optional(),
  recentlyUpdated: z.boolean().optional(),
  internalNotes: z.string().max(4000).optional(),
});

adminDocsRouter.patch(
  "/articles/:locale/:category/:slug",
  requireSuperAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = metaPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", details: parsed.error.issues } });
        return;
      }
      const locale = param(req.params.locale);
      const category = param(req.params.category);
      const slug = param(req.params.slug);
      await upsertArticleMeta({
        locale,
        category,
        slug,
        title: parsed.data.title,
        plans: parsed.data.plans,
        status: parsed.data.status,
        recentlyUpdated: parsed.data.recentlyUpdated,
        internalNotes: parsed.data.internalNotes,
        updatedByUserId: (req as unknown as { user?: { userId?: string } }).user?.userId,
      });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
