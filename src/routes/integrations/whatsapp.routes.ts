import { Router } from "express";
import { authenticateToken } from "../../middleware/auth";
import { gateFeature } from "../../middleware/feature-gate";
import * as ctrl from "../../controllers/integrations/whatsapp.controller";

// ============================================================================
// WHATSAPP INTEGRATION ROUTES — mounted at /api/integrations/whatsapp
// ----------------------------------------------------------------------------
// All session-authed. The public GET/POST /webhooks live in a separate
// raw-body router mounted before express.json (whatsapp-webhooks.routes).
// ============================================================================
const router = Router();

router.use(authenticateToken);

// /status (drives the entitlement/upsell screen) + /disconnect (cleanup) stay
// ungated so a disabled tenant still gets a coherent screen, never a 403 wall.
router.get("/status", ctrl.status);
router.post("/disconnect", ctrl.disconnect);

// Everything that connects or serves inbox data respects the admin toggle.
router.post("/connect", gateFeature("whatsapp"), ctrl.connect);
router.get("/conversations", gateFeature("whatsapp"), ctrl.conversations);
router.get("/conversations/:id/messages", gateFeature("whatsapp"), ctrl.messages);
router.post("/conversations/:id/messages", gateFeature("whatsapp"), ctrl.reply);
router.post("/conversations/:id/attach-deal", gateFeature("whatsapp"), ctrl.attachDeal);

router.get("/templates", gateFeature("whatsapp"), ctrl.templates);
router.get("/health", gateFeature("whatsapp"), ctrl.health);

export default router;
