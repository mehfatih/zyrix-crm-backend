import { Router } from "express";
import * as controller from "../controllers/email.controller";
import { authenticateToken } from "../middleware/auth";

// ============================================================================
// EMAIL ROUTES — /api/email/* (Sprint 10). Authenticated CRM-user surface.
// (Open-pixel / click-redirect live separately at /api/t/* — public.)
// ============================================================================
const router = Router();
router.use(authenticateToken);

router.get("/contact/:contactId", controller.listContactEmails);
router.get("/best-send-time/:contactId", controller.bestSendTime);
router.post("/send", controller.send);
router.post("/ai-draft", controller.aiDraft);
router.post("/:id/reply-ai", controller.replyAi);
router.get("/:id", controller.getEmail);

export default router;
