import { Router } from "express";
import * as controller from "../controllers/insights.controller";
import { authenticateToken, requireRole } from "../middleware/auth";

const router = Router();

router.use(authenticateToken);
// Company-wide decision support (revenue at risk, priorities) — managers up.
router.use(requireRole("super_admin", "owner", "admin", "manager"));

router.get("/executive-summary", controller.executiveSummary);
router.get("/priority-actions", controller.priorityActions);

export default router;
