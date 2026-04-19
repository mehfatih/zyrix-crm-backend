import { Router } from "express";
import * as controller from "../controllers/whatsapp.controller";
import { authenticateToken } from "../middleware/auth";

const router = Router();

router.use(authenticateToken);

router.post("/message/incoming", controller.receiveIncoming);
router.post("/message/outgoing", controller.sendOutgoing);
router.get("/customers/:customerId/chats", controller.getChatHistory);
router.post("/ai/suggest-reply", controller.aiSuggestReply);
router.post("/ai/summarize/:customerId", controller.aiSummarize);

export default router;