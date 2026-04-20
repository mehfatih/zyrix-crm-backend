import { Router } from "express";
import * as controller from "../controllers/tax.controller";
import { authenticateToken } from "../middleware/auth";

const router = Router();

router.use(authenticateToken);

router.get("/presets", controller.presets);
router.post("/seed", controller.seedPresets);

router.get("/", controller.list);
router.post("/", controller.create);
router.get("/:id", controller.getOne);
router.patch("/:id", controller.update);
router.delete("/:id", controller.remove);

export default router;
