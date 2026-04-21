import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import * as ctrl from "../controllers/session-events.controller";

const router = Router();
router.use(authenticateToken);

router.post("/", ctrl.record);
router.get("/kpis", ctrl.kpis);

export default router;
