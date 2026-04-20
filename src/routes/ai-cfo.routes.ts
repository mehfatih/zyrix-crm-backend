import { Router } from "express";
import * as controller from "../controllers/ai-cfo.controller";
import { authenticateToken } from "../middleware/auth";

const router = Router();

router.use(authenticateToken);

router.get("/templates", controller.templates);
router.get("/snapshot", controller.snapshot);
router.post("/ask", controller.ask);

export default router;
