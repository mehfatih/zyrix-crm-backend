import { Router } from "express";
import * as controller from "../controllers/payments-collect.controller";
import { authenticateToken, requireRole } from "../middleware/auth";

// ============================================================================
// PAYMENT COLLECTION — /api/payments/* (Sprint 15E, authenticated).
// Connect/manage = owner/admin/manager; collect link = any authenticated staff.
// ============================================================================
const router = Router();
router.use(authenticateToken);

const canManage = requireRole("owner", "admin", "manager");

router.get("/connections", controller.list);
router.post("/connections", canManage, controller.connect);
router.delete("/connections/:provider", canManage, controller.remove);
router.post("/quotes/:id/collect", controller.collectForQuote);

export default router;
