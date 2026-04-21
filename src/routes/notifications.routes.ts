import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import * as ctrl from "../controllers/notifications.controller";

const router = Router();
router.use(authenticateToken);

router.get("/", ctrl.list);
router.get("/unread-count", ctrl.unreadCount);
router.post("/mark-read", ctrl.markRead);
router.delete("/:id", ctrl.remove);

export default router;
