import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import * as ctrl from "../controllers/ai-messaging.controller";

// ============================================================================
// AI MESSAGE COMPOSER — /api/ai/messages/* (Sprint 15F, authenticated).
// ============================================================================
const router = Router();
router.use(authenticateToken);

router.post("/draft", ctrl.draft);
router.post("/improve-tone", ctrl.improve);
router.post("/translate", ctrl.translate);

export default router;
