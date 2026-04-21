import { Router } from "express";
import * as controller from "../controllers/whatsapp.controller";
import { authenticateToken } from "../middleware/auth";

const router = Router();

// ──────────────────────────────────────────────────────────────────────────
// PUBLIC — Meta Cloud API webhook (no auth)
// Meta calls GET for verification handshake, POST for incoming messages
// ──────────────────────────────────────────────────────────────────────────
router.get("/webhook", controller.metaWebhookVerify);
router.post("/webhook", controller.metaWebhookReceive);

// ──────────────────────────────────────────────────────────────────────────
// AUTHENTICATED — inbox, threads, sending, AI
// ──────────────────────────────────────────────────────────────────────────
router.use(authenticateToken);

// New inbox UX
router.get("/inbox", controller.getInbox);
router.get("/thread/:phoneNumber", controller.getThread);
router.post("/send", controller.sendMetaMessage);

// Legacy demo endpoints (kept for compatibility)
router.post("/message/incoming", controller.receiveIncoming);
router.post("/message/outgoing", controller.sendOutgoing);
router.get("/customers/:customerId/chats", controller.getChatHistory);
router.post("/ai/suggest-reply", controller.aiSuggestReply);
router.post("/ai/summarize/:customerId", controller.aiSummarize);

export default router;
