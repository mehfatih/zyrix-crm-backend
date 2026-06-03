import { Router } from "express";
import { requireSuperAdmin } from "../middleware/superAdmin";
import * as ctrl from "../controllers/support-admin.controller";

// ============================================================================
// ZYRIX SUPPORT CONSOLE ROUTES — /api/admin/support-console (super-admin)
// ----------------------------------------------------------------------------
// Distinct from /api/admin/tickets (the existing support_tickets system).
// MUST be mounted BEFORE the /api/admin router so the SSE stream route (which
// uses ?token= auth, not a header) isn't intercepted by that router's global
// requireSuperAdmin. The stream route is declared before requireSuperAdmin here
// for the same reason.
// ============================================================================
const router = Router();

router.get("/:id/stream", ctrl.stream);

router.use(requireSuperAdmin);
router.get("/queue", ctrl.queue);
router.get("/:id", ctrl.thread);
router.post("/:id/claim", ctrl.claim);
router.post("/:id/reply", ctrl.reply);
router.post("/:id/close", ctrl.close);

export default router;
