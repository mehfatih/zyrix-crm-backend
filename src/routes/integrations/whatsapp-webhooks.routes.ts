import { Router, raw } from "express";
import { verify, receive } from "../../controllers/integrations/whatsapp-webhook.controller";

// ============================================================================
// WHATSAPP WEBHOOK RECEIVER ROUTER
// ----------------------------------------------------------------------------
// PUBLIC. GET = Meta verification handshake (query params, no body). POST =
// events — needs the RAW body for X-Hub-Signature-256, so this router is
// mounted BEFORE express.json() in index.ts.
// ============================================================================
const router = Router();

router.get("/", verify);
router.post("/", raw({ type: "*/*", limit: "2mb" }), receive);

export default router;
