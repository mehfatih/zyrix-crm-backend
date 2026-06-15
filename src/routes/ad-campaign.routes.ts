import { Router } from "express";
import * as controller from "../controllers/ad-campaign.controller";
import { authenticateToken, requireRole } from "../middleware/auth";
import { requireFeature } from "../middleware/entitlement-gate";

// ============================================================================
// CAMPAIGN ECONOMICS ROUTES — /api/ad-campaigns/* (Sprint 24, authenticated)
// Gated by the `campaign_economics` entitlement (BUSINESS_UP). Build/mutate =
// owner/admin/manager; read = any authenticated user.
// ============================================================================
const router = Router();
router.use(authenticateToken);
router.use(requireFeature("campaign_economics"));

const canBuild = requireRole("owner", "admin", "manager");

// Campaigns
router.get("/", controller.list);
router.post("/", canBuild, controller.create);
router.get("/:id", controller.getOne);
router.patch("/:id", canBuild, controller.update);
router.delete("/:id", canBuild, controller.remove);

// Spend ledger (manual entry; direct platform-API pulls deferred to later sprints)
router.get("/:id/spend", controller.listSpend);
router.post("/:id/spend", canBuild, controller.addSpend);
router.patch("/:id/spend/:spendId", canBuild, controller.updateSpend);
router.delete("/:id/spend/:spendId", canBuild, controller.deleteSpend);

export default router;
