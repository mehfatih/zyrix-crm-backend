import { Router, raw } from "express";
import { verify, receive } from "../../controllers/integrations/meta-webhook.controller";

// ============================================================================
// UNIFIED META WEBHOOK RECEIVER ROUTER — /api/integrations/meta/webhook
// ----------------------------------------------------------------------------
// PUBLIC. GET = handshake. POST = events (Page leadgen + Messenger/IG DMs) —
// needs the RAW body for X-Hub-Signature-256, so mounted BEFORE express.json().
// Canonical callback for the Page + Instagram objects. WhatsApp's webhook
// (separate object/URL) is untouched.
// ============================================================================
const router = Router();

router.get("/", verify);
router.post("/", raw({ type: "*/*", limit: "2mb" }), receive);

export default router;
