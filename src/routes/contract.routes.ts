import { Router } from "express";
import * as controller from "../controllers/contract.controller";
import { authenticateToken } from "../middleware/auth";

const router = Router();

router.use(authenticateToken);

router.get("/stats", controller.stats);
router.get("/", controller.list);
router.post("/", controller.create);
router.get("/:id", controller.getOne);
router.patch("/:id", controller.update);
router.post("/:id/reminder", controller.createReminder);
router.delete("/:id", controller.remove);

export default router;
