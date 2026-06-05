import { Router, raw, type Request, type Response } from "express";
import { env } from "../../config/env";
import {
  verifyResendSignature,
  processResendEvent,
  logResendWebhook,
} from "../../services/resend-webhook.service";

// ============================================================================
// RESEND WEBHOOK RECEIVER — Sprint 10
// PUBLIC, raw-body (Svix HMAC over the exact bytes). Mounted BEFORE
// express.json() in index.ts. Returns 503 until RESEND_WEBHOOK_SECRET is set.
// ============================================================================
const router = Router();

router.post("/", raw({ type: "*/*", limit: "1mb" }), async (req: Request, res: Response) => {
  if (!env.RESEND_WEBHOOK_SECRET) {
    res.status(503).json({ success: false, error: { code: "RESEND_WEBHOOK_NOT_CONFIGURED", message: "Webhook secret not set" } });
    return;
  }
  const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  const headers = {
    "svix-id": req.header("svix-id") ?? undefined,
    "svix-timestamp": req.header("svix-timestamp") ?? undefined,
    "svix-signature": req.header("svix-signature") ?? undefined,
  };
  if (!verifyResendSignature(rawBody, headers)) {
    res.status(401).json({ success: false, error: { code: "INVALID_SIGNATURE", message: "Bad signature" } });
    return;
  }

  let payload: { type?: string; data?: { email_id?: string } };
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    res.status(400).json({ success: false, error: { code: "BAD_JSON", message: "Invalid JSON" } });
    return;
  }

  try {
    const r = await processResendEvent(payload);
    logResendWebhook(r.companyId, payload.type ?? "?", true);
    // Phase C: emit email.bounced automation when r.bounced.
  } catch (e) {
    console.error("[resend-webhook] processing failed:", (e as Error).message);
    logResendWebhook(null, payload.type ?? "?", false);
  }
  // Always 200 once verified — Resend retries on non-2xx; processing is best-effort.
  res.status(200).json({ success: true });
});

export default router;
