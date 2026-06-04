import { Router, json } from "express";
import rateLimit from "express-rate-limit";
import { ready, receive } from "../../controllers/integrations/google-ads-webhook.controller";

// ============================================================================
// GOOGLE ADS LEAD FORMS WEBHOOK ROUTER
//   mounted at /api/integrations/google-ads/leads/webhook (PUBLIC)
// ----------------------------------------------------------------------------
// The company id is the route param. Body is plain JSON (no HMAC), so we parse
// it with a SCOPED express.json — this router is mounted BEFORE the global
// express.json() in index.ts, so the parser here only ever runs for this path.
// Per-company rate limit (keyed by :companyId) mirrors the public workflow
// webhook so one busy tenant can't starve others.
// ============================================================================
const router = Router();

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: (req) => `gads:${req.params.companyId ?? "unknown"}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: "RATE_LIMITED", message: "Too many requests" },
  },
});

router.get("/:companyId", ready);
router.post("/:companyId", limiter, json({ type: "*/*", limit: "1mb" }), (req, res) => {
  void receive(req, res);
});

export default router;
