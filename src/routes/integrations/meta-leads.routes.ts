import { Router } from "express";
import { authenticateToken } from "../../middleware/auth";
import * as ctrl from "../../controllers/integrations/meta-leads.controller";

// ============================================================================
// META LEAD ADS ROUTES — mounted at /api/integrations/meta/leads
// ----------------------------------------------------------------------------
// All session-authed. The public GET/POST /webhook lives in a separate
// raw-body router mounted before express.json (meta-leads-webhooks.routes).
// ============================================================================
const router = Router();

router.use(authenticateToken);

router.post("/connect", ctrl.connect);
router.get("/status", ctrl.status);
router.post("/disconnect", ctrl.disconnect);

router.get("/leads", ctrl.leads);
router.get("/health", ctrl.health);

export default router;
