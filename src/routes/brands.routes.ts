import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import * as ctrl from "../controllers/brands.controller";

const router = Router();
router.use(authenticateToken);

router.get("/", ctrl.list);
router.get("/stats", ctrl.stats);
router.get("/:id", ctrl.detail);
router.post("/", ctrl.create);
router.patch("/:id", ctrl.update);
router.post("/:id/default", ctrl.setDefault);
router.delete("/:id", ctrl.remove);

export default router;
