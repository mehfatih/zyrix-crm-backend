// ============================================================================
// WHATSAPP SEND SERVICE
// ----------------------------------------------------------------------------
// Outbound messaging via the Cloud API. Enforces the 24-hour service window:
// free-form text is only allowed inside the window; outside it, an approved
// TEMPLATE is required (WHATSAPP_TEMPLATE_REQUIRED). Records outbound + failure
// events. Never logs the access token.
// ============================================================================

import { notFound } from "../../middleware/errorHandler";
import { integrationError } from "../../lib/errors/integrationErrors";
import {
  isWhatsAppConfigured,
  getAccessToken,
  getWabaId,
  graphMessagesUrl,
  graphUrl,
} from "./config";
import {
  getConversation,
  isWithinWindow,
  appendMessage,
  touchOutbound,
} from "./conversations.service";
import { recordIntegrationEvent } from "../integration-events.service";

const SEND_TIMEOUT_MS = 15000;

async function graphSend(payload: Record<string, unknown>): Promise<{ messageId: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(graphMessagesUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getAccessToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw integrationError("WHATSAPP_SEND_FAILED", "Graph send timed out", { platform: "whatsapp" });
    }
    throw integrationError("WHATSAPP_SEND_FAILED", `Graph send failed: ${(err as Error).message}`, {
      platform: "whatsapp",
    });
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    if (resp.status === 429) {
      throw integrationError("RATE_LIMITED", "WhatsApp rate limited the send", { platform: "whatsapp" });
    }
    throw integrationError("WHATSAPP_SEND_FAILED", `Graph ${resp.status}: ${text.slice(0, 200)}`, {
      platform: "whatsapp",
      status: resp.status,
    });
  }
  const json = (await resp.json()) as { messages?: Array<{ id?: string }> };
  return { messageId: json?.messages?.[0]?.id ?? null };
}

/** Free-form text reply — only inside the 24h window. */
export async function sendText(
  companyId: string,
  conversationId: string,
  text: string,
  userId: string
): Promise<{ messageId: string | null }> {
  if (!isWhatsAppConfigured()) {
    throw integrationError("WHATSAPP_NOT_CONFIGURED", "WhatsApp is not configured", {
      platform: "whatsapp",
      companyId,
    });
  }
  const conv = await getConversation(companyId, conversationId);
  if (!conv) throw notFound("Conversation");
  if (!isWithinWindow(conv)) {
    throw integrationError(
      "WHATSAPP_TEMPLATE_REQUIRED",
      "Outside the 24-hour window — an approved template is required",
      { platform: "whatsapp", companyId, conversationId }
    );
  }
  const { messageId } = await graphSend({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: conv.externalThreadId,
    type: "text",
    text: { body: text },
  });
  await appendMessage({
    conversationId,
    companyId,
    direction: "out",
    externalMessageId: messageId,
    type: "text",
    body: text,
    status: "sent",
    sentByUserId: userId,
    sentAt: new Date(),
  });
  await touchOutbound(conversationId);
  await recordIntegrationEvent({
    companyId,
    platform: "whatsapp",
    eventType: "whatsapp_message_out",
    requestContext: { conversationId, externalMessageId: messageId, kind: "text" },
  });
  return { messageId };
}

/** Template message — allowed inside or outside the window. */
export async function sendTemplate(
  companyId: string,
  conversationId: string,
  templateName: string,
  language: string,
  components: unknown,
  userId: string
): Promise<{ messageId: string | null }> {
  if (!isWhatsAppConfigured()) {
    throw integrationError("WHATSAPP_NOT_CONFIGURED", "WhatsApp is not configured", {
      platform: "whatsapp",
      companyId,
    });
  }
  const conv = await getConversation(companyId, conversationId);
  if (!conv) throw notFound("Conversation");
  const template: Record<string, unknown> = {
    name: templateName,
    language: { code: language || "en_US" },
  };
  if (Array.isArray(components) && components.length) template.components = components;
  const { messageId } = await graphSend({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: conv.externalThreadId,
    type: "template",
    template,
  });
  await appendMessage({
    conversationId,
    companyId,
    direction: "out",
    externalMessageId: messageId,
    type: "template",
    body: `[template] ${templateName}`,
    status: "sent",
    sentByUserId: userId,
    sentAt: new Date(),
  });
  await touchOutbound(conversationId);
  await recordIntegrationEvent({
    companyId,
    platform: "whatsapp",
    eventType: "whatsapp_message_out",
    requestContext: { conversationId, externalMessageId: messageId, kind: "template", template: templateName },
  });
  return { messageId };
}

export interface WhatsAppTemplate {
  name: string;
  language: string;
  status: string;
  category: string;
}

/** List approved templates from the WABA (for the reply-out-of-window UI). */
export async function listTemplates(): Promise<WhatsAppTemplate[]> {
  const waba = getWabaId();
  if (!isWhatsAppConfigured() || !waba) return [];
  try {
    const resp = await fetch(graphUrl(`${waba}/message_templates?limit=100`), {
      headers: { Authorization: `Bearer ${getAccessToken()}` },
    });
    if (!resp.ok) return [];
    const json = (await resp.json()) as { data?: any[] };
    return (json.data ?? []).map((t) => ({
      name: t.name,
      language: t.language,
      status: t.status,
      category: t.category,
    }));
  } catch {
    return [];
  }
}
