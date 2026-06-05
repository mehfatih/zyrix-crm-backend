import { Router } from "express";
import * as controller from "../controllers/form-flows.controller";
import { authenticateToken, requireRole } from "../middleware/auth";

// ============================================================================
// FORM FLOWS ROUTES — /api/form-flows/* (Sprint 12, authenticated)
// Build/mutate = owner/admin/manager; read = any authenticated user.
// ============================================================================
const router = Router();
router.use(authenticateToken);

const canBuild = requireRole("owner", "admin", "manager");

router.get("/", controller.list);
router.post("/", canBuild, controller.create);
router.get("/:id", controller.getOne);
router.get("/:id/qr", controller.qr);
router.get("/:id/submissions", controller.submissions);
// Internal wizard submit — any authenticated staff (Guided entry)
router.post("/:id/submit", controller.internalSubmit);
router.patch("/:id", canBuild, controller.update);
router.delete("/:id", canBuild, controller.remove);
router.post("/:id/activate", canBuild, controller.activate);
router.post("/:id/archive", canBuild, controller.archive);
router.post("/:id/regenerate-token", canBuild, controller.regenerateToken);

export default router;
