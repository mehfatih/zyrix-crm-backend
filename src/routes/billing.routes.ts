import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import { requirePermission } from "../middleware/requirePermission";
import * as controller from "../controllers/billing.controller";

const router = Router();
router.use(authenticateToken);

router.get("/plans", controller.listPlans);
router.get("/current", controller.currentBilling);
router.get("/invoices", controller.listInvoices);
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
