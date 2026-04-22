import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import { requirePermission } from "../middleware/requirePermission";
import * as ctrl from "../controllers/brands.controller";

const router = Router();
router.use(authenticateToken);

router.get("/", ctrl.list);
router.get("/stats", ctrl.stats);
router.get("/:id", ctrl.detail);
router.post("/", requirePermission("settings:branding"), ctrl.create);
router.patch("/:id", requirePermission("settings:branding"), ctrl.update);
router.post("/:id/default", requirePermission("settings:branding"), ctrl.setDefault);
router.delete("/:id", requirePermission("settings:branding"), ctrl.remove);

export default router;
