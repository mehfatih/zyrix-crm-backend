import type { Request, Response } from "express";
import { verifyWebhookHmac, processWebhook } from "../../services/shopify/webhooks";
import { recordIntegrationEvent } from "../../services/integration-events.service";

// ============================================================================
// SHOPIFY WEBHOOK RECEIVER — POST /api/integrations/shopify/webhooks
// ----------------------------------------------------------------------------
// PUBLIC + RAW body (mounted before express.json in index.ts). Verifies the
// HMAC with the app secret, acks Shopify with a fast 200, then processes the
// payload detached. Never logs secrets/tokens/raw body.
// ============================================================================
export async function receive(req: Request, res: Response): Promise<void> {
  const rawBody: Buffer = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(typeof req.body === "string" ? req.body : "");
  const hmac = req.header("X-Shopify-Hmac-Sha256");
  const topic = req.header("X-Shopify-Topic") || "";
  const shop = req.header("X-Shopify-Shop-Domain") || "";
  const webhookId = req.header("X-Shopify-Webhook-Id") || undefined;

  if (!verifyWebhookHmac(rawBody, hmac)) {
    void recordIntegrationEvent({
      companyId: null,
      eventType: "webhook_failed",
      errorCode: "INVALID_HMAC",
      errorMessage: "Webhook HMAC verification failed",
      requestContext: { shop, topic, webhookId, route: req.originalUrl },
    });
    res.status(401).send("invalid hmac");
    return;
  }

  // Acknowledge immediately (Shopify expects a 200 within ~5s), then process
  // detached so a slow DB write can never cause a delivery timeout/retry.
  res.status(200).send("ok");

  let payload: unknown = {};
  try {
    payload = JSON.parse(rawBody.toString("utf8") || "{}");
  } catch {
    payload = {};
  }
  void processWebhook(topic, shop, payload, webhookId).catch((e) => {
    console.error("[shopify-webhook] process error (non-fatal):", (e as Error).message);
  });
}
