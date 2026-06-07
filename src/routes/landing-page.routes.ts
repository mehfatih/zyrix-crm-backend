import { Router } from "express";
import * as controller from "../controllers/landing-page.controller";
import { authenticateToken, requireRole } from "../middleware/auth";
import { requireFeature, enforceLimit } from "../middleware/entitlement-gate";
import { countLandingPages } from "../middleware/entitlement-counters";

// ============================================================================
// LANDING PAGES ROUTES — /api/landing-pages/* (Sprint 20, authenticated)
// Gated by the `landing_pages` entitlement (LIMIT feature: starter 1 /
// business+ unlimited). Build/mutate = owner/admin/manager; read = any user.
// ============================================================================
const router = Router();
router.use(authenticateToken);
router.use(requireFeature("landing_pages"));

const canBuild = requireRole("owner", "admin", "manager");

router.get("/", controller.list);
router.post("/", canBuild, enforceLimit("landing_pages", countLandingPages), controller.create);
router.get("/:id", controller.getOne);
router.patch("/:id", canBuild, controller.update);
router.delete("/:id", canBuild, controller.remove);
router.post("/:id/publish", canBuild, controller.setPublished);
// AI one-click copy (Phase B)
router.post("/:id/generate", canBuild, controller.generate);
router.post("/:id/generate-block", canBuild, controller.generateBlock);

export default router;
