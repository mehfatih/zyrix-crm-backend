import { Router } from "express";
import { authenticateToken } from "../../middleware/auth";
import * as ctrl from "../../controllers/integrations/google-ads.controller";

// ============================================================================
// GOOGLE ADS LEAD FORMS ROUTES — mounted at /api/integrations/google-ads
// ----------------------------------------------------------------------------
// All session-authed. The public POST /leads/webhook/:companyId lives in a
// separate router mounted before express.json (google-ads-webhooks.routes).
// ============================================================================
const router = Router();

router.use(authenticateToken);

router.get("/config", ctrl.getConfig);
router.put("/config", ctrl.putConfig);
router.post("/rotate-key", ctrl.rotate);
router.get("/recent", ctrl.recent);

export default router;
