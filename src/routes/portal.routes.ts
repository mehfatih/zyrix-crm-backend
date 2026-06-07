import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import * as PortalSvc from "../services/portal.service";
import * as Kb from "../services/kb.service";

const router = Router();

// ============================================================================
// CUSTOMER PORTAL ROUTES — /api/portal/*
// Public (no JWT auth) — uses magic-link + session tokens
// ============================================================================

const magicLinkLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

const requestSchema = z.object({
  email: z.string().email(),
  portalUrl: z.string().url().optional(),
});

const verifySchema = z.object({
  token: z.string().min(10),
});

// Middleware: resolve session token from Authorization header
async function requireSession(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      res.status(401).json({
        success: false,
        error: { code: "UNAUTHENTICATED", message: "Session required" },
      });
      return;
    }
    const sessionToken = auth.slice(7);
    const customer = await PortalSvc.resolveSession(sessionToken);
    (req as any).portalCustomer = customer;
    (req as any).portalSessionToken = sessionToken;
    next();
  } catch (e) {
    next(e);
  }
}

// POST /api/portal/magic-link — request login link
router.post(
  "/magic-link",
  magicLinkLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dto = requestSchema.parse(req.body);
      const portalBaseUrl =
        dto.portalUrl ||
        `${req.protocol}://${req.get("host")}/portal/callback`;
      await PortalSvc.issueMagicLink(dto.email, portalBaseUrl);
      // Always return success to avoid email enumeration
      res.status(200).json({ success: true, data: { sent: true } });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/portal/verify — exchange magic token for session
router.post(
  "/verify",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dto = verifySchema.parse(req.body);
      const ip = (req.ip || req.socket.remoteAddress || "").slice(0, 64);
      const ua = (req.get("user-agent") || "").slice(0, 512);
      const result = await PortalSvc.verifyMagicToken(dto.token, ip, ua);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/portal/me — customer info
router.get(
  "/me",
  requireSession,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customer = (req as any).portalCustomer;
      res.status(200).json({ success: true, data: customer });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/portal/dashboard — customer's records
router.get(
  "/dashboard",
  requireSession,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customer = (req as any).portalCustomer;
      const data = await PortalSvc.getCustomerDashboard(customer.id);
      res.status(200).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/portal/requests — customer raises a support request → ticket
const portalRequestSchema = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
});
router.post(
  "/requests",
  requireSession,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customer = (req as any).portalCustomer as { id: string; companyId: string };
      const dto = portalRequestSchema.parse(req.body);
      const result = await PortalSvc.createPortalRequest(customer, dto.subject, dto.body);
      res.status(result.created ? 201 : 200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }
);

// ── PORTAL PAYMENTS (Sprint 22) ─────────────────────────────────────────────
// POST /api/portal/quotes/:id/pay — create a checkout link for the customer's
// own quote (reuses Sprint-15E payments-collect rails). Rate-limited.
const payLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
router.post(
  "/quotes/:id/pay",
  requireSession,
  payLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customer = (req as any).portalCustomer as { id: string; companyId: string };
      const data = await PortalSvc.payPortalQuote(customer, String(req.params.id));
      res.status(200).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
);

// ── HELP CENTER (Knowledge Base, published articles) ────────────────────────
// GET /api/portal/help — categories + published articles (browse/search)
router.get(
  "/help",
  requireSession,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customer = (req as any).portalCustomer as { companyId: string };
      const locale = typeof req.query.locale === "string" ? req.query.locale : undefined;
      const data = await Kb.listPublished(customer.companyId, locale, {
        q: typeof req.query.q === "string" ? req.query.q : undefined,
        categoryId: typeof req.query.categoryId === "string" ? req.query.categoryId : undefined,
      });
      res.status(200).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/portal/help/articles/:slug — single published article (localized)
router.get(
  "/help/articles/:slug",
  requireSession,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customer = (req as any).portalCustomer as { companyId: string };
      const locale = typeof req.query.locale === "string" ? req.query.locale : undefined;
      const article = await Kb.getPublishedArticle(customer.companyId, String(req.params.slug), locale);
      if (!article) {
        return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Article not found" } });
      }
      res.status(200).json({ success: true, data: article });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/portal/help/articles/:id/helpful — { helpful: boolean }
const helpfulSchema = z.object({ helpful: z.boolean() });
router.post(
  "/help/articles/:id/helpful",
  requireSession,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customer = (req as any).portalCustomer as { companyId: string };
      const dto = helpfulSchema.parse(req.body);
      await Kb.recordHelpful(customer.companyId, String(req.params.id), dto.helpful);
      res.status(200).json({ success: true, data: { ok: true } });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/portal/help/ask — AI answer grounded ONLY on published articles
const askLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
const askSchema = z.object({
  message: z.string().min(1).max(2000),
  locale: z.string().max(5).optional(),
  history: z.array(z.object({ role: z.string(), text: z.string().max(4000) })).max(12).optional(),
});
router.post(
  "/help/ask",
  requireSession,
  askLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customer = (req as any).portalCustomer as { companyId: string };
      const dto = askSchema.parse(req.body);
      const data = await Kb.askGrounded(customer.companyId, dto.locale, dto.message, dto.history ?? []);
      res.status(200).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/portal/logout
router.post(
  "/logout",
  requireSession,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = (req as any).portalSessionToken as string;
      await PortalSvc.logout(token);
      res.status(200).json({ success: true, data: { ok: true } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
