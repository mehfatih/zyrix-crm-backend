import { Router } from "express";
import * as controller from "../controllers/cac.controller";
import * as costController from "../controllers/acquisition-cost.controller";
import { authenticateToken, requireRole } from "../middleware/auth";
import { requireFeature } from "../middleware/entitlement-gate";

// ============================================================================
// CAC ROUTES — /api/cac/* (authenticated)
// Gated by the `cac` entitlement (ALL_ON — gift to every plan). Read is limited
// to owner/admin/manager since CAC exposes spend/acquisition-cost data.
//
// Sprint 1: read-only CAC analytics (/monthly).
// Sprint 2 (Phase 1): non-ad acquisition cost ledger (/costs). Read stays
// owner/admin/manager; WRITE is owner/admin only (salaries/commissions sensitive).
// ============================================================================
const router = Router();
router.use(authenticateToken);
router.use(requireFeature("cac"));

const canRead = requireRole("owner", "admin", "manager");
const canWrite = requireRole("owner", "admin");

// Monthly CAC — blended + per-platform + coverage (?months=1..36, default 12)
router.get("/monthly", canRead, controller.monthly);

// Non-ad acquisition cost ledger (Sprint 2, Phase 1)
router.get("/costs", canRead, costController.list);
router.post("/costs", canWrite, costController.create);
router.patch("/costs/:id", canWrite, costController.update);
router.delete("/costs/:id", canWrite, costController.remove);

export default router;
