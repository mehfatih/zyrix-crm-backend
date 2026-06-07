import { Router } from "express";
import * as controller from "../../controllers/calendar-sync.controller";
import { authenticateToken } from "../../middleware/auth";

// ============================================================================
// CALENDAR SYNC — /api/integrations/calendar/* (Sprint 21)
// The Google OAuth callback is PUBLIC (browser redirect from Google); the rest
// require auth. Mirrors the 15D email-inbox routes.
// ============================================================================
const router = Router();

// Public OAuth callback — must be registered BEFORE the auth middleware.
router.get("/google/callback", controller.calendarCallback);

router.use(authenticateToken);
router.get("/", controller.list);
router.get("/google/connect", controller.calendarConnect);
router.post("/:id/sync", controller.syncNow);
router.delete("/:id", controller.remove);

export default router;
