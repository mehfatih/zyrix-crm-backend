import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../../types";
import { badRequest } from "../../middleware/errorHandler";
import { integrationError } from "../../lib/errors/integrationErrors";
import {
  isWhatsAppConfigured,
  getPhoneNumberId,
  getWabaId,
} from "../../services/whatsapp/config";
import * as numbers from "../../services/whatsapp/numbers.service";
import * as conv from "../../services/whatsapp/conversations.service";
import { sendText, sendTemplate, listTemplates } from "../../services/whatsapp/send";
import {
  recordIntegrationEvent,
  countEventsByType,
  recentFailures,
} from "../../services/integration-events.service";
import { recordAudit, extractRequestMeta } from "../../utils/audit";

// ============================================================================
// WHATSAPP INTEGRATION CONTROLLER (/api/integrations/whatsapp) — session auth
// ============================================================================

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

// POST /connect — claim the env-configured number for this company.
export async function connect(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, companyId } = auth(req);
    if (!isWhatsAppConfigured()) {
      throw integrationError("WHATSAPP_NOT_CONFIGURED", "WhatsApp is not configured on this deployment", {
        platform: "whatsapp",
        companyId,
      });
    }
    const phoneNumberId = getPhoneNumberId() as string;
    await numbers.registerNumber({ companyId, phoneNumberId, wabaId: getWabaId() ?? null });
    await recordIntegrationEvent({
      companyId,
      platform: "whatsapp",
      eventType: "oauth_success",
      requestContext: { phoneNumberId, userId, action: "connect" },
    });
    await recordAudit({
      userId,
      companyId,
      action: "integration.whatsapp.connected",
      entityType: "whatsapp_number",
      entityId: phoneNumberId,
      metadata: { phoneNumberId },
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data: { connected: true, phoneNumberId } });
  } catch (err) {
    next(err);
  }
}

// GET /status
export async function status(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const number = await numbers.getNumberForCompany(companyId);
    res.status(200).json({
      success: true,
      data: {
        configured: isWhatsAppConfigured(),
        connected: Boolean(number && number.status === "connected"),
        number,
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
    await numbers.removeNumberForCompany(companyId);
    await recordIntegrationEvent({
      companyId,
      platform: "whatsapp",
      eventType: "disconnect",
      requestContext: { userId },
    });
    res.status(200).json({ success: true, data: { disconnected: true } });
  } catch (err) {
    next(err);
  }
}

// GET /conversations
export async function conversations(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const statusQ = typeof req.query.status === "string" ? req.query.status : undefined;
    const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined;
    const list = await conv.listConversations(companyId, { status: statusQ, limit });
    res.status(200).json({ success: true, data: { conversations: list } });
  } catch (err) {
    next(err);
  }
}

// GET /conversations/:id/messages
export async function messages(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const id = String(req.params.id);
    const c = await conv.getConversation(companyId, id);
    if (!c) {
      return res
        .status(404)
        .json({ success: false, error: { code: "NOT_FOUND", message: "Conversation not found" } });
    }
    const msgs = await conv.getMessages(companyId, id);
    await conv.markRead(companyId, id);
    res.status(200).json({
      success: true,
      data: { conversation: { ...c, withinWindow: conv.isWithinWindow(c) }, messages: msgs },
    });
  } catch (err) {
    next(err);
  }
}

// POST /conversations/:id/messages — reply (text inside window, or template)
export async function reply(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, companyId } = auth(req);
    const id = String(req.params.id);
    const body = (req.body ?? {}) as {
      text?: string;
      type?: string;
      template?: { name: string; language?: string; components?: unknown };
    };

    if (body.type === "template" && body.template?.name) {
      const r = await sendTemplate(
        companyId,
        id,
        body.template.name,
        body.template.language ?? "en_US",
        body.template.components,
        userId
      );
      return res.status(200).json({ success: true, data: { messageId: r.messageId } });
    }

    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) throw badRequest("Message text is required");
    const r = await sendText(companyId, id, text, userId);
    res.status(200).json({ success: true, data: { messageId: r.messageId } });
  } catch (err) {
    next(err);
  }
}

// POST /conversations/:id/attach-deal — body { dealId } | null to detach
export async function attachDeal(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dealId = typeof req.body?.dealId === "string" ? req.body.dealId : null;
    await conv.attachDeal(companyId, String(req.params.id), dealId);
    res.status(200).json({ success: true, data: { attached: Boolean(dealId) } });
  } catch (err) {
    next(err);
  }
}

// GET /templates
export async function templates(_req: Request, res: Response, next: NextFunction) {
  try {
    const t = await listTemplates();
    res.status(200).json({ success: true, data: { templates: t } });
  } catch (err) {
    next(err);
  }
}

// GET /health — WhatsApp delivery metrics for the dashboard.
export async function health(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const windowHours = req.query.window === "7d" ? 24 * 7 : 24;
    const counts = await countEventsByType(companyId, "whatsapp", windowHours);
    const failures = await recentFailures(companyId, "whatsapp", 10);
    res.status(200).json({
      success: true,
      data: {
        windowHours,
        messagesIn: counts.whatsapp_message_in ?? 0,
        messagesOut: counts.whatsapp_message_out ?? 0,
        sendFailures: counts.whatsapp_send_failed ?? 0,
        webhookInvalid: counts.whatsapp_webhook_invalid ?? 0,
        recentFailures: failures,
      },
    });
  } catch (err) {
    next(err);
  }
}
