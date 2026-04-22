import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticateToken } from "../middleware/auth";
import { gateFeature } from "../middleware/feature-gate";
import * as ctrl from "../controllers/ai-modes.controller";

// Gemini calls are latency-expensive + token-cost. Cap per user to keep
// a single chatty session from draining the key.
const limiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const router = Router();
router.use(authenticateToken);
router.use(gateFeature("ai_build_modes"));
router.use(limiter);

router.post("/architect", ctrl.architect);
router.post("/builder", ctrl.builder);
router.post("/report", ctrl.report);

export default router;
