import { Router } from "express";
import * as controller from "../../controllers/email-inbox.controller";
import { authenticateToken } from "../../middleware/auth";

// ============================================================================
// EMAIL INBOX CONNECT — /api/integrations/email-inbox/* (Sprint 15D)
// The Gmail OAuth callback is PUBLIC (browser redirect from Google); the rest
// require auth.
// ============================================================================
const router = Router();

// Public OAuth callback — must be registered BEFORE the auth middleware.
router.get("/google/callback", controller.gmailCallback);

router.use(authenticateToken);
router.get("/", controller.list);
router.get("/gmail/connect", controller.gmailConnect);
router.post("/imap", controller.imapConnect);
router.post("/:id/sync", controller.syncNow);
router.delete("/:id", controller.remove);

export default router;
