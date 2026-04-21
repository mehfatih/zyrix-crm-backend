import { Router } from "express";
import * as controller from "../controllers/chat.controller";
import { authenticateToken } from "../middleware/auth";

const router = Router();

router.use(authenticateToken);

router.get("/threads", controller.threads);
router.get("/team", controller.team);
router.get("/unread", controller.unreadCount);
router.get("/conversation/:userId", controller.conversation);
router.post("/send", controller.send);

export default router;
