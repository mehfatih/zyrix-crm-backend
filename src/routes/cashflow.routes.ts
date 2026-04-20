import { Router } from "express";
import * as controller from "../controllers/cashflow.controller";
import { authenticateToken } from "../middleware/auth";

const router = Router();

router.use(authenticateToken);

router.get("/forecast", controller.forecast);
router.get("/historical", controller.historical);

export default router;
