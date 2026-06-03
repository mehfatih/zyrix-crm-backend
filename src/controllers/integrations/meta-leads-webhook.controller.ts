import type { Request, Response } from "express";
import { getVerifyToken } from "../../services/meta-leads/config";
import { verifySignature, processWebhookPayload } from "../../services/meta-leads/webhook";
import { recordIntegrationEvent } from "../../services/integration-events.service";

// ============================================================================
// META LEAD ADS WEBHOOK RECEIVER — /api/integrations/meta/leads/webhook
// ----------------------------------------------------------------------------
// PUBLIC + RAW body (mounted before express.json). GET = Meta verification
// handshake; POST = leadgen events (verify X-Hub-Signature-256, ack fast,
// process detached). Dedicated URL — never overlaps the WhatsApp messages
// webhook. Never logs tokens or lead PII as secrets.
// ============================================================================

/** GET — Meta verification handshake: echo hub.challenge if the token matches. */
export function verify(req: Request, res: Response): void {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const expected = getVerifyToken();
  if (mode === "subscribe" && expected && token === expected) {
    res.status(200).send(String(challenge ?? ""));
    return;
  }
  res.status(403).send("forbidden");
}

/** POST — event delivery: verify signature, 200 fast, process detached. */
export function receive(req: Request, res: Response): void {
  const rawBody: Buffer = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(typeof req.body === "string" ? req.body : "");
  const sig = req.header("X-Hub-Signature-256");

  if (!verifySignature(rawBody, sig)) {
    void recordIntegrationEvent({
      companyId: null,
      platform: "meta",
      eventType: "meta_lead_webhook_invalid",
      errorCode: "META_LEAD_SIGNATURE_INVALID",
      errorMessage: "Invalid X-Hub-Signature-256",
      requestContext: { route: req.originalUrl },
    });
    res.status(401).send("invalid signature");
    return;
  }

  res.status(200).send("ok"); // ack within Meta's timeout, then process

  let payload: unknown = {};
  try {
    payload = JSON.parse(rawBody.toString("utf8") || "{}");
  } catch {
    payload = {};
  }
  void processWebhookPayload(payload).catch((e) =>
    console.error("[meta-leads-webhook] process error (non-fatal):", (e as Error).message)
  );
}
