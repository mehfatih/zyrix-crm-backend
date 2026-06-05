import { Router, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { getPublicForm, loadPublicFlowForSubmit, submitForm } from "../services/form-submit.service";

// ============================================================================
// PUBLIC FORM ROUTES — /api/f/* (Sprint 12). No auth. Rate-limited.
// Random tokens (no enumeration); active public flows only.
// ============================================================================
const router = Router();

const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30, // per token+IP per hour
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.params.token || ""}:${req.ip}`,
  message: { success: false, error: { code: "RATE_LIMITED", message: "Too many submissions. Try again later." } },
});

// Render data for the public page.
router.get("/:token", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await getPublicForm(req.params.token as string);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
});

// Submit.
router.post("/:token/submit", submitLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { companyId, flow } = await loadPublicFlowForSubmit(req.params.token as string);
    const body = req.body ?? {};
    const result = await submitForm(
      { companyId, flow, source: "public" },
      { data: body.data ?? {}, honeypot: body.honeypot, elapsedMs: Number(body.elapsedMs) },
    );
    res.status(200).json({ success: true, data: { submitted: true, dropped: result.dropped } });
  } catch (err) { next(err); }
});

export default router;
