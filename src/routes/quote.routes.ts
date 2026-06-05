import { Router } from "express";
import * as controller from "../controllers/quote.controller";
import { authenticateToken, requireRole } from "../middleware/auth";
import { gateFeature } from "../middleware/feature-gate";

const router = Router();

router.use(authenticateToken);
router.use(gateFeature("quotes"));

router.get("/stats", controller.stats);
router.get("/ai-suggest", controller.aiSuggest);
router.get("/", controller.list);
router.post("/", controller.create);
router.get("/:id", controller.getOne);
router.get("/:id/events", controller.events);
router.patch("/:id", controller.update);
router.post("/:id/send", controller.send);
router.post("/:id/accept", controller.accept);
router.post("/:id/reject", controller.reject);
// Discount approval flow (Sprint 9)
router.post("/:id/request-approval", controller.requestApproval);
router.post("/:id/approve", requireRole("owner", "admin"), controller.approve);
router.post("/:id/deny", requireRole("owner", "admin"), controller.deny);
router.delete("/:id", controller.remove);

export default router;
