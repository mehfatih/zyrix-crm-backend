import { Router } from "express";
import * as controller from "../controllers/followup.controller";
import { authenticateToken } from "../middleware/auth";

const router = Router();

router.use(authenticateToken);

router.get("/settings", controller.getSettings);
router.put("/settings", controller.upsertSettings);
router.get("/stale", controller.stale);
router.post("/tasks/:customerId", controller.createTask);
router.post("/tasks/bulk", controller.bulkCreateTasks);

export default router;
