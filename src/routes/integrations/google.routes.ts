import { Router } from "express";
import { authenticateToken } from "../../middleware/auth";
import * as ctrl from "../../controllers/integrations/google.controller";

// ============================================================================
// GOOGLE WORKSPACE INTEGRATION ROUTES — mounted at /api/integrations/google
// ----------------------------------------------------------------------------
// GET /callback is PUBLIC (Google redirects the merchant's browser here; we
// identify the company via the one-shot oauth_states nonce). Everything else
// requires session auth.
// ============================================================================

const router = Router();

// Public OAuth callback — registered BEFORE the auth middleware.
router.get("/callback", ctrl.callback);

// Session-authed endpoints.
router.use(authenticateToken);
router.get("/status", ctrl.status);
router.post("/connect", ctrl.connect);
router.post("/disconnect", ctrl.disconnect);

// Export
router.post("/export/sheets", ctrl.exportSheets);

// Save to Drive (Quotes + Contracts PDFs)
router.post("/save-to-drive", ctrl.saveToDrive);

// Import contacts from a Google Sheet (preview only; commit via /api/import)
router.post("/import/sheet", ctrl.importSheet);

export default router;
