import { Router } from "express";
import * as controller from "../controllers/cadence.controller";
import { authenticateToken } from "../middleware/auth";
import { gateFeature } from "../middleware/feature-gate";

// ============================================================================
// CADENCE ROUTES — /api/cadences/* (Sprint 11). Gated by marketing_automation.
// ============================================================================
const router = Router();

router.use(authenticateToken);
router.use(gateFeature("marketing_automation"));

router.get("/", controller.list);
router.post("/", controller.create);
router.get("/contact/:contactId/enrollments", controller.contactEnrollments);
router.post("/enrollments/:enrollmentId/unenroll", controller.unenroll);
router.get("/:id", controller.getOne);
router.patch("/:id", controller.update);
router.delete("/:id", controller.remove);
router.post("/:id/activate", controller.activate);
router.post("/:id/pause", controller.pause);
router.post("/:id/enroll", controller.enroll);

export default router;
