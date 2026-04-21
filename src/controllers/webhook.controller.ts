import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as WebhookSvc from "../services/webhook.service";
import type { AuthenticatedRequest } from "../types";

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

// ============================================================================
// PUBLIC RECEIVER — no auth, raw body
//
// Route: POST /api/webhooks/:platform/:companyId
// Body MUST be Buffer (configured via express.raw({type:"application/json"})
// on just this path — see index.ts wiring). HMAC verification depends on the
// exact bytes, so re-serializing through express.json() would silently break
// every signature.
//
// We ALWAYS respond 200 unless the platform is unsupported or the body
// shape is unusable. Platforms (Shopify/Salla) aggressively retry on non-2xx
// responses, and returning 401 for signature mismatches would flood us with
// retries from an attacker spamming fake deliveries. We log signatureOk:false
// on the event row instead, so ops can investigate without back-pressure.
// ============================================================================
export async function receive(req: Request, res: Response, next: NextFunction) {
  try {
    const platform = (req.params.platform as string || "").toLowerCase();
    const companyId = req.params.companyId as string;

    if (!platform || !companyId) {
      res.status(400).json({
        success: false,
        error: { message: "platform and companyId are required" },
      });
      return;
    }

    // req.body is Buffer when express.raw is active on this route; handle both.
    const rawBody: Buffer = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(
          typeof req.body === "string" ? req.body : JSON.stringify(req.body || {})
        );

    const outcome = await WebhookSvc.verifyAndRecord({
      platform,
      companyId,
      rawBody,
      headers: req.headers,
    });

    // Fire-and-forget processing so the HTTP response stays fast.
    // Errors inside processEvent are persisted on the webhook_event row.
    if (outcome.signatureOk) {
      setImmediate(() => {
        WebhookSvc.processEvent(outcome.eventId).catch(() => {
          // Swallow — processEvent already persists errors to the event row.
        });
      });
    }

    res.status(200).json({ success: true, received: true });
  } catch (err) {
    next(err);
  }
}

// ============================================================================
// AUTHENTICATED — subscription management
// ============================================================================

export async function listSubscriptions(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const storeId = req.query.storeId as string | undefined;
    const data = await WebhookSvc.listSubscriptions(companyId, storeId);

    // Compute the public URL for each platform once so the UI can show it
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const withUrls = data.map((s) => ({
      ...s,
      publicUrl: WebhookSvc.getPublicUrl(s.platform, companyId, baseUrl),
    }));

    res.status(200).json({ success: true, data: withUrls });
  } catch (err) {
    next(err);
  }
}

const createSchema = z.object({
  platform: z.string().min(1).max(50),
  topic: z.string().min(1).max(100),
  storeId: z.string().uuid().nullable().optional(),
});

export async function createSubscription(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const dto = createSchema.parse(req.body);
    const sub = await WebhookSvc.createSubscription(companyId, {
      platform: dto.platform,
      topic: dto.topic,
      storeId: dto.storeId ?? null,
    });
    // Secret returned exactly once here — show-and-forget in the UI
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    res.status(201).json({
      success: true,
      data: {
        id: sub.id,
        platform: sub.platform,
        topic: sub.topic,
        storeId: sub.storeId,
        isActive: sub.isActive,
        secret: sub.secret,
        publicUrl: WebhookSvc.getPublicUrl(sub.platform, companyId, baseUrl),
        createdAt: sub.createdAt,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function rotateSecret(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const sub = await WebhookSvc.rotateSecret(
      companyId,
      req.params.id as string
    );
    res.status(200).json({
      success: true,
      data: { id: sub.id, secret: sub.secret, updatedAt: sub.updatedAt },
    });
  } catch (err) {
    next(err);
  }
}

const patchSchema = z.object({ isActive: z.boolean() });

export async function updateSubscription(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const { isActive } = patchSchema.parse(req.body);
    const sub = await WebhookSvc.setActive(
      companyId,
      req.params.id as string,
      isActive
    );
    res.status(200).json({ success: true, data: sub });
  } catch (err) {
    next(err);
  }
}

export async function deleteSubscription(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await WebhookSvc.deleteSubscription(
      companyId,
      req.params.id as string
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function listEvents(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const limit = parseInt((req.query.limit as string) || "50", 10);
    const platform = (req.query.platform as string) || undefined;
    const status = (req.query.status as string) || undefined;
    const data = await WebhookSvc.listRecentEvents(
      companyId,
      Number.isFinite(limit) ? limit : 50,
      platform,
      status
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function getSupportedPlatforms(_req: Request, res: Response) {
  res.status(200).json({
    success: true,
    data: WebhookSvc.SUPPORTED_PLATFORMS,
  });
}
