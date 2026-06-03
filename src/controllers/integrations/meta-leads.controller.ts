import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../../types";
import { badRequest } from "../../middleware/errorHandler";
import { isWebhookConfigured, isLeadsConfigured } from "../../services/meta-leads/config";
import * as pages from "../../services/meta-leads/pages.service";
import { listLeads, countLeads } from "../../services/meta-leads/leads.service";
import {
  recordIntegrationEvent,
  countEventsByType,
  recentFailures,
} from "../../services/integration-events.service";
import { recordAudit, extractRequestMeta } from "../../utils/audit";

// ============================================================================
// META LEAD ADS CONTROLLER (/api/integrations/meta/leads) — session auth
// ============================================================================

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

// POST /connect — claim a Facebook Page for this company. Body: { pageId,
// pageName?, pageToken? }. When pageToken is given it is sealed at rest;
// otherwise the env-level default token is used at fetch time.
export async function connect(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, companyId } = auth(req);
    const pageId = typeof req.body?.pageId === "string" ? req.body.pageId.trim() : "";
    if (!pageId) throw badRequest("pageId is required");
    const pageName = typeof req.body?.pageName === "string" ? req.body.pageName : null;
    const pageToken = typeof req.body?.pageToken === "string" ? req.body.pageToken : null;

    await pages.registerPage({ companyId, pageId, pageName, pageToken });
    await recordIntegrationEvent({
      companyId,
      platform: "meta",
      eventType: "oauth_success",
      requestContext: { pageId, userId, action: "connect_lead_page" },
    });
    await recordAudit({
      userId,
      companyId,
      action: "integration.meta_leads.connected",
      entityType: "meta_lead_page",
      entityId: pageId,
      metadata: { pageId, hasPageToken: Boolean(pageToken) },
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data: { connected: true, pageId } });
  } catch (err) {
    next(err);
  }
}

// GET /status
export async function status(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const page = await pages.getPageForCompany(companyId);
    res.status(200).json({
      success: true,
      data: {
        // webhook ready (app secret + verify token) and lead-fetch ready (token)
        webhookConfigured: isWebhookConfigured(),
        leadsConfigured: isLeadsConfigured(),
        connected: Boolean(page && page.status === "connected"),
        page: page
          ? { id: page.id, pageId: page.pageId, pageName: page.pageName, status: page.status }
          : null,
      },
    });
  } catch (err) {
    next(err);
  }
}

// POST /disconnect
export async function disconnect(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, companyId } = auth(req);
    await pages.removePageForCompany(companyId);
    await recordIntegrationEvent({
      companyId,
      platform: "meta",
      eventType: "disconnect",
      requestContext: { userId, action: "disconnect_lead_page" },
    });
    res.status(200).json({ success: true, data: { disconnected: true } });
  } catch (err) {
    next(err);
  }
}

// GET /leads — recently imported leads (with attribution) for this company.
export async function leads(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined;
    const list = await listLeads(companyId, { limit });
    res.status(200).json({ success: true, data: { leads: list } });
  } catch (err) {
    next(err);
  }
}

// GET /health — Lead Ads metrics for the dashboard.
export async function health(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const windowHours = req.query.window === "7d" ? 24 * 7 : 24;
    const counts = await countEventsByType(companyId, "meta", windowHours);
    const failures = await recentFailures(companyId, "meta", 10);
    const recentLeads = await countLeads(companyId, windowHours);
    res.status(200).json({
      success: true,
      data: {
        windowHours,
        leadsReceived: counts.meta_lead_received ?? 0,
        fetchFailures: counts.meta_lead_fetch_failed ?? 0,
        webhookInvalid: counts.meta_lead_webhook_invalid ?? 0,
        recentLeads,
        recentFailures: failures,
      },
    });
  } catch (err) {
    next(err);
  }
}
