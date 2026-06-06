import { Router, raw, type Request, type Response } from "express";
import { env } from "../../config/env";
import { verifyResendSignature } from "../../services/resend-webhook.service";
import { processInboundReply } from "../../services/resend-inbound.service";
import { dispatchEmailReplied } from "../../services/workflow-events.service";
import { onContactReplied } from "../../services/cadence.service";

// ============================================================================
// RESEND INBOUND RECEIVER — Sprint 15C
// PUBLIC, raw-body (Svix HMAC over exact bytes, INBOUND secret). Mounted BEFORE
// express.json(). Returns 503 until RESEND_INBOUND_WEBHOOK_SECRET is set.
// On a matched reply: stores the inbound row, fires email.replied + cadence
// auto-exit. Always 200 once verified (Resend retries on non-2xx).
// ============================================================================
const router = Router();

router.post("/", raw({ type: "*/*", limit: "2mb" }), async (req: Request, res: Response) => {
  if (!env.RESEND_INBOUND_WEBHOOK_SECRET) {
    res.status(503).json({ success: false, error: { code: "RESEND_INBOUND_NOT_CONFIGURED", message: "Inbound secret not set" } });
    return;
  }
  const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  const headers = {
    "svix-id": req.header("svix-id") ?? undefined,
    "svix-timestamp": req.header("svix-timestamp") ?? undefined,
    "svix-signature": req.header("svix-signature") ?? undefined,
  };
  if (!verifyResendSignature(rawBody, headers, env.RESEND_INBOUND_WEBHOOK_SECRET)) {
    res.status(401).json({ success: false, error: { code: "INVALID_SIGNATURE", message: "Bad signature" } });
    return;
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    res.status(400).json({ success: false, error: { code: "BAD_JSON", message: "Invalid JSON" } });
    return;
  }

  try {
    const r = await processInboundReply(payload);
    if (r.matched && r.companyId && r.originalEmailId && r.replyText) {
      void dispatchEmailReplied(r.companyId, {
        emailId: r.originalEmailId,
        customerId: r.contactId,
        replyPreview: r.replyText.slice(0, 280),
        repliedAt: new Date().toISOString(),
      });
      if (r.contactId) void onContactReplied(r.companyId, r.contactId);
    }
  } catch (e) {
    console.error("[resend-inbound] processing failed:", (e as Error).message);
  }
  res.status(200).json({ success: true });
});

export default router;
