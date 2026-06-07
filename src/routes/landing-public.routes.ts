import { Router, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { getPublicPage, recordViewBySlug } from "../services/landing-page.service";

// ============================================================================
// PUBLIC LANDING PAGE ROUTES — /api/p/* (Sprint 20). No auth. Rate-limited.
// Render data for the SSR page at /p/:companySlug/:pageSlug. The CTA form
// reuses the Sprint-12 public form path (/api/f/:token/submit) — anti-spam,
// contact/deal upsert and form.submitted all come for free.
// ============================================================================
const router = Router();

const viewLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60, // per company+page+IP per minute (beacon)
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.params.companySlug || ""}:${req.params.pageSlug || ""}:${req.ip}`,
  message: { success: false, error: { code: "RATE_LIMITED", message: "Too many requests." } },
});

// Render payload for the public page.
router.get("/:companySlug/:pageSlug", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await getPublicPage(String(req.params.companySlug), String(req.params.pageSlug));
    if (!data) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Page not found" } });
    }
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
});

// View beacon — fired once client-side on mount (keeps crawlers/prefetch from
// inflating the count). Success-shaped even on no-op.
router.post("/:companySlug/:pageSlug/view", viewLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const counted = await recordViewBySlug(String(req.params.companySlug), String(req.params.pageSlug));
    res.status(200).json({ success: true, data: { counted } });
  } catch (err) { next(err); }
});

export default router;
