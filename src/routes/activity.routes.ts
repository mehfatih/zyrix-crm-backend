import { Router } from "express";
import * as controller from "../controllers/activity.controller";
import { authenticateToken } from "../middleware/auth";

const router = Router();

router.use(authenticateToken);

router.get("/", controller.list);
router.post("/", controller.create);
router.post("/:id/complete", controller.complete);
router.delete("/:id", controller.remove);

export default router;