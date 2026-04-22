import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import { requirePermission } from "../middleware/requirePermission";
import * as ctrl from "../controllers/audit-logs.controller";

const router = Router();

// All routes require admin:audit permission. We mount this above the
// /api/audit-logs base; the legacy /api/security/audit is kept in
// security.routes.ts for backwards compatibility with the existing UI.
router.use(authenticateToken);
router.use(requirePermission("admin:audit"));

router.get("/", ctrl.list);
router.get("/actions", ctrl.actions);
router.get("/export.json", ctrl.exportJson);
router.get("/export.csv", ctrl.exportCsv);

export default router;
