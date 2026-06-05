import { Router } from "express";
import * as controller from "../controllers/data-tools.controller";
import { authenticateToken, requireRole } from "../middleware/auth";

// ============================================================================
// DATA TOOLS ROUTES — /api/data-tools/* (Sprint 13)
// Scan/verdict = any authenticated staff; merge/undo (destructive) +
// cleanup apply = owner/admin/manager.
// ============================================================================
const router = Router();
router.use(authenticateToken);

const canManage = requireRole("owner", "admin", "manager");

router.post("/dedupe/scan", controller.dedupeScan);
router.post("/dedupe/verdict", controller.dedupeVerdict);
router.post("/merge", canManage, controller.merge);
router.post("/merge/:logId/undo", canManage, controller.undo);
router.get("/merge-logs", controller.mergeLogs);

router.post("/cleanup/preview", controller.cleanupPreview);
router.post("/cleanup/apply", canManage, controller.cleanupApply);
router.post("/cleanup/:logId/undo", canManage, controller.cleanupUndo);

export default router;

