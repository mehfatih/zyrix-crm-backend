import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import * as ctrl from "../controllers/oauth.controller";

// ============================================================================
// OAUTH ROUTES (mounted at /api/oauth)
// ----------------------------------------------------------------------------
// Install + connection-management endpoints require session auth.
// Callback endpoints are PUBLIC — the provider redirects the user's
// browser here and we identify them via the state nonce, not by cookies.
// ============================================================================

const router = Router();

// Public callback — MUST be registered before the auth middleware
router.get("/:provider/callback", ctrl.callback);

// Session-authed endpoints
router.use(authenticateToken);

// Install flow — redirects user to the provider's consent screen
router.get("/:provider/install", ctrl.install);

// List currently connected stores
router.get("/connections", ctrl.listConnections);

// Disconnect a store
router.delete("/connections/:id", ctrl.disconnect);

// Which providers are configured in this deployment (for conditional UI)
router.get("/providers", ctrl.providerStatus);

export default router;
