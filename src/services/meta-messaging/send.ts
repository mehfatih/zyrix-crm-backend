// ============================================================================
// META MESSAGING — SEND SERVICE (Messenger + Instagram, Send API)
// ----------------------------------------------------------------------------
// POST {PAGE_ID}/messages with recipient {id: PSID|IGSID}. Enforces the
// 24-hour standard messaging window (mirrors the WhatsApp window logic): inside
// the window, free-form RESPONSE messages are allowed; outside it, a reply is
// only permitted via an approved message tag (e.g. HUMAN_AGENT → 7 days).
// Records outbound + failure events. Never logs the Page token.
// ============================================================================

import { notFound } from "../../middleware/errorHandler";
import { integrationError } from "../../lib/errors/integrationErrors";
import { isMessagingConfigured, getPageToken, graphSendUrl } from "./config";
import {
  getConversation,
  isWithinWindow,
  appendMessage,
  touchOutbound,
} from "../whatsapp/conversations.service";
import { recordIntegrationEvent } from "../integration-events.service";

const SEND_TIMEOUT_MS = 15000;

// Tags Meta permits outside the 24h window. HUMAN_AGENT extends to 7 days for a
// human response; the others are use-case tags. Validated before send.
const ALLOWED_TAGS = new Set([
  "HUMAN_AGENT",
  "CONFIRMED_EVENT_UPDATE",
  "POST_PURCHASE_UPDATE",
  "ACCOUNT_UPDATE",
]);

async function graphSend(payload: Record<string, unknown>): Promise<{ messageId: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(graphSendUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getPageToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw integrationError("META_MSG_SEND_FAILED", "Send timed out", { platform: "meta" });
    }
    throw integrationError("META_MSG_SEND_FAILED", `Send failed: ${(err as Error).message}`, {
      platform: "meta",
    });
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    if (resp.status === 429) {
      throw integrationError("RATE_LIMITED", "Meta rate limited the send", { platform: "meta" });
    }
    throw integrationError("META_MSG_SEND_FAILED", `Graph ${resp.status}: ${text.slice(0, 200)}`, {
      platform: "meta",
      status: resp.status,
    });
  }
  const json = (await resp.json()) as { message_id?: string };
  return { messageId: json?.message_id ?? null };
}

/**
 * Send a reply on a Messenger/Instagram conversation. Inside the 24h window a
 * free-form text is sent (messaging_type RESPONSE). Outside the window, a `tag`
 * is REQUIRED (messaging_type MESSAGE_TAG) — otherwise META_MSG_TAG_REQUIRED.
 */
export async function sendMessage(
  companyId: string,
  conversationId: string,
  text: string,
  userId: string,
  tag?: string | null
): Promise<{ messageId: string | null }> {
  if (!isMessagingConfigured()) {
    throw integrationError("META_MESSAGING_NOT_CONFIGURED", "Meta messaging is not configured", {
      platform: "meta",
      companyId,
    });
  }
  const conv = await getConversation(companyId, conversationId);
  if (!conv) throw notFound("Conversation");

  const withinWindow = isWithinWindow(conv);
  const payload: Record<string, unknown> = {
    recipient: { id: conv.externalThreadId },
    message: { text },
  };

  if (withinWindow) {
    payload.messaging_type = "RESPONSE";
  } else {
    if (!tag) {
      throw integrationError(
        "META_MSG_TAG_REQUIRED",
        "Outside the 24-hour window — an approved message tag is required",
        { platform: "meta", companyId, conversationId, channel: conv.channel }
      );
    }
    if (!ALLOWED_TAGS.has(tag)) {
      throw integrationError("META_MSG_TAG_REQUIRED", `Unsupported message tag: ${tag}`, {
        platform: "meta",
        companyId,
        conversationId,
      });
    }
    payload.messaging_type = "MESSAGE_TAG";
    payload.tag = tag;
  }

  const { messageId } = await graphSend(payload);
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
    platform: "meta",
    eventType: "meta_msg_out",
    requestContext: { conversationId, channel: conv.channel, externalMessageId: messageId, tagged: Boolean(tag) },
  });
  return { messageId };
}
