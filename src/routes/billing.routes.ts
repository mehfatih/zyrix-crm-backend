import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import * as controller from "../controllers/billing.controller";

const router = Router();
router.use(authenticateToken);

router.get("/plans", controller.listPlans);
router.get("/current", controller.currentBilling);
router.get("/invoices", controller.listInvoices);
router.post("/subscriptions/:id/cancel", controller.cancel);
router.post("/subscriptions/:id/resume", controller.resume);

export default router;
