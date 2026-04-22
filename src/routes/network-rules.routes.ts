import { Router } from "express";
import { requireSuperAdmin } from "../middleware/superAdmin";
import * as ctrl from "../controllers/network-rules.controller";

const router = Router();
router.use(requireSuperAdmin);

router.get("/", ctrl.list);
router.post("/", ctrl.create);
router.patch("/:id", ctrl.update);
router.delete("/:id", ctrl.remove);

export default router;
