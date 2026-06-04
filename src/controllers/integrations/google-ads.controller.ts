import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../../types";
import { env } from "../../config/env";
import {
  getOrCreateConfig,
  rotateKey,
  updateConfig,
  type GoogleAdsConfigView,
} from "../../services/google-ads/config.service";
import { listRecentLeads } from "../../services/google-ads/leads.service";
import { recordIntegrationEvent } from "../../services/integration-events.service";
import { recordAudit, extractRequestMeta } from "../../utils/audit";

// ============================================================================
// GOOGLE ADS LEAD FORMS CONTROLLER (/api/integrations/google-ads) — session auth
// ----------------------------------------------------------------------------
// Owner-facing settings: read/rotate the webhook key, edit the field mapping +
// default stage, and list recently ingested leads (incl. test). The webhook key
// is only ever returned to the authenticated owner of the company.
// ============================================================================

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

/** Build the public webhook URL the merchant pastes into Google Ads. */
function webhookUrl(companyId: string): string {
  const base = env.API_URL.replace(/\/+$/, "");
  return `${base}/api/integrations/google-ads/leads/webhook/${companyId}`;
}

function toResponse(companyId: string, cfg: GoogleAdsConfigView) {
  return {
    webhookUrl: webhookUrl(companyId),
    webhookKey: cfg.webhookKey,
    mapping: cfg.mapping,
    defaultPipelineStage: cfg.defaultPipelineStage,
    status: cfg.status,
    createdAt: cfg.createdAt,
    updatedAt: cfg.updatedAt,
  };
}

// GET /config — current config (creates one with a fresh key on first access).
export async function getConfig(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const cfg = await getOrCreateConfig(companyId);
    res.status(200).json({ success: true, data: toResponse(companyId, cfg) });
  } catch (err) {
    next(err);
  }
}

// PUT /config — update mapping / defaultPipelineStage / status.
export async function putConfig(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, companyId } = auth(req);
    const body = (req.body ?? {}) as {
      mapping?: Record<string, string> | null;
      defaultPipelineStage?: string | null;
      status?: string;
    };
    const cfg = await updateConfig(companyId, {
      mapping: body.mapping,
      defaultPipelineStage: body.defaultPipelineStage,
      status: body.status,
    });
    await recordAudit({
      userId,
      companyId,
      action: "integration.google_ads.config_updated",
      entityType: "google_ads_config",
      entityId: companyId,
      metadata: {
        hasMapping: Boolean(cfg.mapping),
        defaultPipelineStage: cfg.defaultPipelineStage,
        status: cfg.status,
      },
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data: toResponse(companyId, cfg) });
  } catch (err) {
    next(err);
  }
}

// POST /rotate-key — issue a new sealed webhook key.
export async function rotate(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, companyId } = auth(req);
    const cfg = await rotateKey(companyId);
    await recordIntegrationEvent({
      companyId,
      platform: "google_ads",
      eventType: "token_refresh",
      requestContext: { userId, action: "rotate_google_ads_webhook_key" },
    });
    await recordAudit({
      userId,
      companyId,
      action: "integration.google_ads.key_rotated",
      entityType: "google_ads_config",
      entityId: companyId,
      metadata: {},
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data: toResponse(companyId, cfg) });
  } catch (err) {
    next(err);
  }
}

// GET /recent — last N ingested leads (incl. test) with attribution.
export async function recent(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined;
    const leads = await listRecentLeads(companyId, { limit });
    res.status(200).json({ success: true, data: { leads } });
  } catch (err) {
    next(err);
  }
}
