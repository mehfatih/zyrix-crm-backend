import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import * as ctrl from "../controllers/dashboard-layout.controller";

const router = Router();
router.use(authenticateToken);

router.get("/layout", ctrl.get);
router.put("/layout", ctrl.save);
router.delete("/layout", ctrl.reset);

export default router;
