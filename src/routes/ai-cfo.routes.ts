import { Router } from "express";
import * as controller from "../controllers/ai-cfo.controller";
import { authenticateToken } from "../middleware/auth";
import { gateFeature } from "../middleware/feature-gate";

const router = Router();

router.use(authenticateToken);
router.use(gateFeature("ai_cfo"));

router.get("/templates", controller.templates);
router.get("/snapshot", controller.snapshot);
router.post("/ask", controller.ask);

export default router;
