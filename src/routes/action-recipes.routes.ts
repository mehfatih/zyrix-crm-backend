import { Router } from "express";
import * as controller from "../controllers/action-recipes.controller";
import { authenticateToken, requireRole } from "../middleware/auth";

// ============================================================================
// CUSTOM ACTIONS ROUTES — /api/action-recipes/* (Sprint 13)
// Build/mutate = owner/admin/manager; read = any authenticated user.
// ============================================================================
const router = Router();
router.use(authenticateToken);

const canBuild = requireRole("owner", "admin", "manager");

router.get("/", controller.list);
router.post("/", canBuild, controller.create);
router.post("/test", canBuild, controller.test); // dry-run an unsaved config
router.get("/:id", controller.getOne);
router.patch("/:id", canBuild, controller.update);
router.delete("/:id", canBuild, controller.remove);
router.post("/:id/test", canBuild, controller.test); // dry-run a saved recipe

export default router;
