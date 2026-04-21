import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import * as controller from "../controllers/onboarding.controller";

const router = Router();
router.use(authenticateToken);

router.get("/status", controller.status);
router.post("/complete", controller.complete);
router.post("/invite-colleague", controller.invite);

export default router;
