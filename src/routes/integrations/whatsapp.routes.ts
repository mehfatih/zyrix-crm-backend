import { Router } from "express";
import { authenticateToken } from "../../middleware/auth";
import * as ctrl from "../../controllers/integrations/whatsapp.controller";

// ============================================================================
// WHATSAPP INTEGRATION ROUTES — mounted at /api/integrations/whatsapp
// ----------------------------------------------------------------------------
// All session-authed. The public GET/POST /webhooks live in a separate
// raw-body router mounted before express.json (whatsapp-webhooks.routes).
// ============================================================================
const router = Router();

router.use(authenticateToken);

router.post("/connect", ctrl.connect);
router.get("/status", ctrl.status);
router.post("/disconnect", ctrl.disconnect);

router.get("/conversations", ctrl.conversations);
router.get("/conversations/:id/messages", ctrl.messages);
router.post("/conversations/:id/messages", ctrl.reply);
router.post("/conversations/:id/attach-deal", ctrl.attachDeal);

router.get("/templates", ctrl.templates);
router.get("/health", ctrl.health);

export default router;
