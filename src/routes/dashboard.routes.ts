import { Router } from "express";
import * as controller from "../controllers/dashboard.controller";
import { authenticateToken } from "../middleware/auth";

const router = Router();

router.use(authenticateToken);

router.get("/stats", controller.getStats);

export default router;
