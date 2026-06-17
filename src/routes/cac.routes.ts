import { Router } from "express";
import * as controller from "../controllers/cac.controller";
import * as costController from "../controllers/acquisition-cost.controller";
import * as plannedController from "../controllers/planned-spend.controller";
import { authenticateToken, requireRole } from "../middleware/auth";
import { requireFeature } from "../middleware/entitlement-gate";

// ============================================================================
// CAC ROUTES — /api/cac/* (authenticated)
// Gated by the `cac` entitlement (ALL_ON — gift to every plan). Read is limited
// to owner/admin/manager since CAC exposes spend/acquisition-cost data.
//
// Sprint 1: read-only CAC analytics (/monthly).
// Sprint 2 (Phase 1): non-ad acquisition cost ledger (/costs).
// Sprint 2 (Phase 2): planned future spend (/planned) — feeds Sprint-3
//   forecasting; NEVER read by /monthly (actual CAC).
// Read stays owner/admin/manager; WRITE is owner/admin only (sensitive cost data).
// ============================================================================
const router = Router();
router.use(authenticateToken);
router.use(requireFeature("cac"));

const canRead = requireRole("owner", "admin", "manager");
const canWrite = requireRole("owner", "admin");

// Monthly CAC — blended + per-platform + coverage (?months=1..36, default 12)
router.get("/monthly", canRead, controller.monthly);

// Sprint 3 — forecast + recommendations (read-only; consume /monthly + /planned)
router.get("/forecast", canRead, controller.forecast);
router.get("/recommendations", canRead, controller.recommendations);

// Non-ad acquisition cost ledger (Sprint 2, Phase 1)
router.get("/costs", canRead, costController.list);
router.post("/costs", canWrite, costController.create);
router.patch("/costs/:id", canWrite, costController.update);
router.delete("/costs/:id", canWrite, costController.remove);

// Planned future spend (Sprint 2, Phase 2) — forecaster input; not in actual CAC
router.get("/planned", canRead, plannedController.list);
router.post("/planned", canWrite, plannedController.create);
router.patch("/planned/:id", canWrite, plannedController.update);
router.delete("/planned/:id", canWrite, plannedController.remove);

export default router;
