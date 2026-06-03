import { Router, raw } from "express";
import { verify, receive } from "../../controllers/integrations/meta-leads-webhook.controller";

// ============================================================================
// META LEAD ADS WEBHOOK RECEIVER ROUTER
// ----------------------------------------------------------------------------
// PUBLIC. GET = Meta verification handshake (query params). POST = leadgen
// events — needs the RAW body for X-Hub-Signature-256, so this router is
// mounted BEFORE express.json() in index.ts. Dedicated URL; does not overlap
// the WhatsApp messages webhook.
// ============================================================================
const router = Router();

router.get("/", verify);
router.post("/", raw({ type: "*/*", limit: "2mb" }), receive);

export default router;
