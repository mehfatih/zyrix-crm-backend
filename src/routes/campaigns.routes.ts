import { Router } from "express";
import * as controller from "../controllers/campaigns.controller";
import { authenticateToken } from "../middleware/auth";
import { gateFeature } from "../middleware/feature-gate";

const router = Router();

router.use(authenticateToken);
router.use(gateFeature("marketing_automation"));

router.get("/stats", controller.stats);
router.get("/", controller.list);
router.post("/", controller.create);
router.get("/:id", controller.getOne);
router.patch("/:id", controller.update);
router.post("/:id/send", controller.send);
router.delete("/:id", controller.remove);

export default router;
