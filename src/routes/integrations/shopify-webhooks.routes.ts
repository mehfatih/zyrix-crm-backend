import { Router, raw } from "express";
import { receive } from "../../controllers/integrations/shopify-webhooks.controller";

// ============================================================================
// SHOPIFY WEBHOOK RECEIVER ROUTER
// ----------------------------------------------------------------------------
// PUBLIC, raw-body. MUST be mounted BEFORE express.json() in index.ts so the
// HMAC sees the exact bytes Shopify signed. 2MB limit (orders/updated payloads
// with large line-item lists). Single POST endpoint; all topics route here and
// are dispatched by the X-Shopify-Topic header.
// ============================================================================
const router = Router();

router.post("/", raw({ type: "*/*", limit: "2mb" }), receive);

export default router;
