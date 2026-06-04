import { Router } from "express";
import * as controller from "../controllers/revenue-brain.controller";
import { authenticateToken, requireRole } from "../middleware/auth";

const router = Router();

router.use(authenticateToken);
// Company-wide revenue forecast — managers and up only.
router.use(requireRole("super_admin", "owner", "admin", "manager"));

router.get("/", controller.revenueBrain);

export default router;
