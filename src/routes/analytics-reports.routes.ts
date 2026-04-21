import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import * as ctrl from "../controllers/analytics-reports.controller";

const router = Router();
router.use(authenticateToken);

// Metric catalog + on-demand runner
router.get("/metrics", ctrl.catalog);
router.post("/run", ctrl.run);

// Scheduled reports CRUD
router.get("/scheduled", ctrl.listScheduled);
router.post("/scheduled", ctrl.createScheduled);
router.patch("/scheduled/:id", ctrl.updateScheduled);
router.delete("/scheduled/:id", ctrl.deleteScheduled);

export default router;
