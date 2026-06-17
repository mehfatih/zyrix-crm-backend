import { Router } from "express";
import * as controller from "../controllers/cac.controller";
import { authenticateToken, requireRole } from "../middleware/auth";
import { requireFeature } from "../middleware/entitlement-gate";

// ============================================================================
// CAC ROUTES — /api/cac/* (Sprint 1: CAC Core, authenticated)
// Gated by the `cac` entitlement (ALL_ON — gift to every plan). Read is limited
// to owner/admin/manager since CAC exposes spend/acquisition-cost data.
// ============================================================================
const router = Router();
router.use(authenticateToken);
router.use(requireFeature("cac"));

const canRead = requireRole("owner", "admin", "manager");

// Monthly CAC — blended + per-platform + coverage (?months=1..36, default 12)
router.get("/monthly", canRead, controller.monthly);

export default router;
