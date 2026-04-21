import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import * as ctrl from "../controllers/templates.controller";

const router = Router();
router.use(authenticateToken);

router.get("/", ctrl.list);
router.get("/applications", ctrl.applications);
router.get("/:slug", ctrl.detail);
router.post("/:slug/apply", ctrl.apply);
router.post("/applications/:id/revert", ctrl.revert);

export default router;
