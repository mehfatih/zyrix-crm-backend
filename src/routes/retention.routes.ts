import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import { requirePermission } from "../middleware/requirePermission";
import * as ctrl from "../controllers/retention.controller";

const router = Router();
router.use(authenticateToken);
router.use(requirePermission("admin:compliance"));

router.get("/", ctrl.list);
router.put("/", ctrl.upsert);
router.delete("/:entityType", ctrl.remove);

export default router;
