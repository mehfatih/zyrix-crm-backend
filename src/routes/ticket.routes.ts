import { Router } from "express";
import * as controller from "../controllers/ticket.controller";
import { authenticateToken } from "../middleware/auth";
import { requireFeature } from "../middleware/entitlement-gate";

// ============================================================================
// SERVICE DESK — TICKETS ROUTES — /api/tickets/* (Sprint 18, authenticated)
// Gated by the `service_desk` entitlement (flag-controlled). The merchant
// toggle (service_desk_settings.enabled) gates auto-create + the UX — entitled
// tenants can still reach /settings to flip it on.
// ============================================================================
const router = Router();
router.use(authenticateToken);
router.use(requireFeature("service_desk"));

// Static paths before /:id
router.get("/settings", controller.getSettings);
router.put("/settings", controller.updateSettings);
router.get("/counts", controller.counts);

router.get("/", controller.list);
router.post("/", controller.create);
router.get("/:id", controller.getOne);
router.patch("/:id", controller.update);
router.post("/:id/reply", controller.reply);
router.post("/:id/take", controller.takeIt);

export default router;
