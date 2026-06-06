import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import { requirePermission } from "../middleware/requirePermission";
import * as controller from "../controllers/billing.controller";

const router = Router();
router.use(authenticateToken);

router.get("/plans", controller.listPlans);
router.get("/current", controller.currentBilling);
router.get("/invoices", controller.listInvoices);

// Sprint 16D — in-app plan change requests
router.get("/plan-request", controller.currentPlanRequest);
router.post(
  "/plan-request",
  requirePermission("settings:billing"),
  controller.planRequest
);
router.post(
  "/plan-request/cancel",
  requirePermission("settings:billing"),
  controller.cancelPlanRequest
);

router.post(
  "/subscriptions/:id/cancel",
  requirePermission("settings:billing"),
  controller.cancel
);
router.post(
  "/subscriptions/:id/resume",
  requirePermission("settings:billing"),
  controller.resume
);

export default router;
