import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import { requirePermission } from "../middleware/requirePermission";
import * as ctrl from "../controllers/api-keys.controller";

const router = Router();
router.use(authenticateToken);
// API keys grant full company access; gate all routes behind settings:integrations.
router.use(requirePermission("settings:integrations"));

router.get("/", ctrl.list);
router.post("/", ctrl.create);
router.delete("/:id", ctrl.revoke);

export default router;
