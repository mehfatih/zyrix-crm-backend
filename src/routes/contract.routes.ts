import { Router } from "express";
import * as controller from "../controllers/contract.controller";
import { authenticateToken } from "../middleware/auth";
import { gateFeature } from "../middleware/feature-gate";

const router = Router();

router.use(authenticateToken);
router.use(gateFeature("contracts"));

router.get("/stats", controller.stats);
router.get("/", controller.list);
router.post("/", controller.create);
router.get("/:id", controller.getOne);
router.patch("/:id", controller.update);
router.post("/:id/reminder", controller.createReminder);
router.delete("/:id", controller.remove);

export default router;
