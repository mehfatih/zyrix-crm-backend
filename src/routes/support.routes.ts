import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import * as ctrl from "../controllers/support.controller";

// ============================================================================
// SUPPORT WIDGET ROUTES — /api/support (merchant session auth)
// ----------------------------------------------------------------------------
// The SSE stream authenticates via a ?token= query param (EventSource cannot
// set an Authorization header), so it is declared BEFORE the global
// authenticateToken middleware. Everything else uses the Bearer token.
// ============================================================================
const router = Router();

router.get("/conversations/:id/stream", ctrl.stream);

router.use(authenticateToken);
router.post("/conversations", ctrl.start);
router.get("/conversations/:id/messages", ctrl.messages);
router.post("/conversations/:id/messages", ctrl.send);
router.post("/conversations/:id/escalate", ctrl.escalate);
router.post("/conversations/:id/close", ctrl.close);
router.post("/conversations/:id/survey", ctrl.survey);

export default router;
