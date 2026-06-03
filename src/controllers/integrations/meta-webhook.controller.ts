import type { Request, Response } from "express";
import { getVerifyToken } from "../../services/meta-messaging/config";
import { verifySignature, processMessagingPayload } from "../../services/meta-messaging/webhook";
import { processWebhookPayload as processLeadgenPayload } from "../../services/meta-leads/webhook";
import { recordIntegrationEvent } from "../../services/integration-events.service";

// ============================================================================
// UNIFIED META WEBHOOK RECEIVER — /api/integrations/meta/webhook
// ----------------------------------------------------------------------------
// PUBLIC + RAW body (mounted before express.json). ONE signature-verify layer
// (shared META_APP_SECRET) + ONE GET handshake (shared verify token), then a
// dispatcher keyed on object/field:
//   • object=page  & entry[].changes[].field=leadgen        → Lead Ads ingest
//   • object=page  & entry[].messaging[]   (Messenger DMs)  → Messaging ingest
//   • object=instagram & entry[].messaging[] (IG DMs)       → Messaging ingest
// This is the canonical callback for the Page + Instagram objects. The
// WhatsApp webhook (object=whatsapp_business_account, separate URL) is NOT
// touched; the /meta/leads/webhook URL remains as a working leadgen-only alias.
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

/** POST — verify signature, ack fast, then dispatch by object/field. */
export function receive(req: Request, res: Response): void {
  const rawBody: Buffer = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(typeof req.body === "string" ? req.body : "");
  const sig = req.header("X-Hub-Signature-256");

  if (!verifySignature(rawBody, sig)) {
    void recordIntegrationEvent({
      companyId: null,
      platform: "meta",
      eventType: "meta_msg_webhook_invalid",
      errorCode: "META_MSG_SIGNATURE_INVALID",
      errorMessage: "Invalid X-Hub-Signature-256",
      requestContext: { route: req.originalUrl },
    });
    res.status(401).send("invalid signature");
    return;
  }

  res.status(200).send("ok"); // ack within Meta's timeout, then process

  let payload: any = {};
  try {
    payload = JSON.parse(rawBody.toString("utf8") || "{}");
  } catch {
    payload = {};
  }

  const entries: any[] = Array.isArray(payload?.entry) ? payload.entry : [];
  const hasLeadgen = entries.some(
    (e) => Array.isArray(e?.changes) && e.changes.some((c: any) => c?.field === "leadgen")
  );
  const hasMessaging = entries.some(
    (e) => Array.isArray(e?.messaging) || Array.isArray(e?.standby)
  );

  if (hasLeadgen) {
    void processLeadgenPayload(payload).catch((e) =>
      console.error("[meta-webhook] leadgen process error (non-fatal):", (e as Error).message)
    );
  }
  if (hasMessaging) {
    void processMessagingPayload(payload).catch((e) =>
      console.error("[meta-webhook] messaging process error (non-fatal):", (e as Error).message)
    );
  }
}
