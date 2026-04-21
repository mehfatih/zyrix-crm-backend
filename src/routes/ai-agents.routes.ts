import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticateToken } from "../middleware/auth";
import * as ctrl from "../controllers/ai-agents.controller";

// ============================================================================
// AI AGENT ROUTES
// ----------------------------------------------------------------------------
// All agents share rate limiting — 60 requests/min per user because Gemini
// calls are expensive and a runaway user can rack up cost quickly. Limits
// are per-user not per-company so one chatty user can't starve their team.
// ============================================================================

const agentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req: any) => req.user?.userId ?? req.ip ?? "unknown",
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: "RATE_LIMITED",
      message: "AI agent rate limit exceeded (60 req/min)",
    },
  },
});

const router = Router();
router.use(authenticateToken);
router.use(agentLimiter);

// Threads (sales assistant)
router.get("/threads", ctrl.list);
router.post("/threads", ctrl.create);
router.get("/threads/:id", ctrl.detail);
router.post("/threads/:id/messages", ctrl.send);
router.delete("/threads/:id", ctrl.archive);

// One-shot endpoints (content writer, meeting notes)
router.post("/content", ctrl.generateContentHandler);
router.post("/meeting-notes", ctrl.meetingNotesHandler);

export default router;
