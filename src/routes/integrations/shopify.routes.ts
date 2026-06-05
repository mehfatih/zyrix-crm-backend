import { Router } from "express";
import { authenticateToken } from "../../middleware/auth";
import * as ctrl from "../../controllers/integrations/shopify.controller";

// ============================================================================
// SHOPIFY INTEGRATION ROUTES — mounted at /api/integrations/shopify
// ----------------------------------------------------------------------------
// GET /callback is PUBLIC (the merchant's browser is redirected here from
// Shopify and we identify the company via the oauth_states nonce + signed
// state cookie). Everything else requires session auth.
// ============================================================================

const router = Router();

// Public callback — registered BEFORE the auth middleware.
router.get("/callback", ctrl.callback);

// Session-authed endpoints.
router.use(authenticateToken);
router.post("/connect", ctrl.connect);
router.get("/status", ctrl.status);
router.post("/disconnect", ctrl.disconnect);
router.get("/health", ctrl.health);
router.get("/products", ctrl.products);
router.post("/resync", ctrl.resync);

export default router;
