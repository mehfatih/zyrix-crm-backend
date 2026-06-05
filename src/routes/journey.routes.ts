import { Router } from "express";
import * as controller from "../controllers/journey.controller";
import { authenticateToken } from "../middleware/auth";
import { gateFeature } from "../middleware/feature-gate";

// ============================================================================
// JOURNEY ROUTES — /api/journeys/* (Sprint 11). Gated by marketing_automation.
// ============================================================================
const router = Router();
router.use(authenticateToken);
router.use(gateFeature("marketing_automation"));

router.get("/", controller.list);
router.post("/", controller.create);
router.post("/validate", controller.validate);
router.post("/test-run", controller.testRun);
router.get("/:id", controller.getOne);
router.patch("/:id", controller.update);
router.delete("/:id", controller.remove);
router.post("/:id/activate", controller.activate);
router.post("/:id/pause", controller.pause);

export default router;
