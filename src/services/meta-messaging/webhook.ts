// ============================================================================
// META MESSAGING — WEBHOOK verify + parse (Messenger + Instagram DMs)
// ----------------------------------------------------------------------------
// SHARED signature scheme with WhatsApp + Lead Ads (same Meta app):
// X-Hub-Signature-256 = "sha256=" + hex(HMAC-SHA256(rawBody, META_APP_SECRET)).
//
// Payloads arrive on the Page object (object="page", Messenger) or the
// Instagram object (object="instagram"). Both carry entry[].messaging[] with
// sender.id = PSID (Messenger) / IGSID (Instagram). We resolve the tenant by
// the recipient Page id (reusing the Sprint-2 page→company map), match/create a
// contact by channel identity, and append to the SAME conversations/messages
// tables (channel = messenger | instagram). Idempotent on the Meta mid.
// ============================================================================

import crypto from "crypto";
import { getAppSecret, getPageToken, getPageId, graphUrl } from "./config";
import { findOrCreateContactByChannelIdentity } from "./identity";
import { getCompanyIdByPageId } from "../meta-leads/pages.service";
import {
  upsertConversation,
  appendMessage,
  touchInbound,
} from "../whatsapp/conversations.service";
import { recordIntegrationEvent } from "../integration-events.service";
import { onContactReplied } from "../cadence.service";
import { ensureTicketForInbound } from "../ticket.service";

/** Verify X-Hub-Signature-256 against the raw body (shared scheme). */
export function verifySignature(rawBody: Buffer, header: string | undefined): boolean {
  const secret = getAppSecret();
  if (!secret || !header) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(header, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** True for object types this module handles (Messenger Page DMs + IG DMs). */
export function isMessagingObject(object: unknown): boolean {
  return object === "page" || object === "instagram";
}

function channelForObject(object: string): "messenger" | "instagram" {
  return object === "instagram" ? "instagram" : "messenger";
}

// Map a Messenger/IG messaging event to { type, body, mediaUrl }.
function extractContent(msg: any): { type: string; body: string | null; mediaUrl: string | null } {
  if (msg.message?.text) return { type: "text", body: String(msg.message.text), mediaUrl: null };
  const att = Array.isArray(msg.message?.attachments) ? msg.message.attachments[0] : null;
  if (att) {
    const type = String(att.type || "file"); // image | audio | video | file | ...
    return { type, body: `[${type}]`, mediaUrl: att.payload?.url ? String(att.payload.url) : null };
  }
  if (msg.postback) {
    return { type: "postback", body: msg.postback.title ? String(msg.postback.title) : String(msg.postback.payload ?? "[postback]"), mediaUrl: null };
  }
  return { type: "text", body: null, mediaUrl: null };
}

/** Best-effort profile name via Graph (never throws — enrichment only). */
async function fetchProfileName(externalId: string): Promise<string | null> {
  const token = getPageToken();
  if (!token) return null;
  try {
    const resp = await fetch(
      `${graphUrl(encodeURIComponent(externalId))}?fields=name,first_name,last_name,username&access_token=${encodeURIComponent(token)}`,
      { method: "GET" }
    );
    if (!resp.ok) return null;
    const j = (await resp.json()) as { name?: string; first_name?: string; last_name?: string; username?: string };
    const composed = j.name || [j.first_name, j.last_name].filter(Boolean).join(" ") || j.username || "";
    return composed.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Process a verified messaging payload. Never throws (the controller already
 * acked 200). Skips echoes (our own sends) and pure read/delivery receipts.
 */
export async function processMessagingPayload(payload: any): Promise<void> {
  const object: string = String(payload?.object ?? "");
  if (!isMessagingObject(object)) return;
  const channel = channelForObject(object);

  const entries: any[] = Array.isArray(payload?.entry) ? payload.entry : [];
  for (const entry of entries) {
    const events: any[] = Array.isArray(entry?.messaging)
      ? entry.messaging
      : Array.isArray(entry?.standby)
        ? entry.standby
        : [];
    for (const ev of events) {
      // Only genuine inbound messages/postbacks. Skip our own echoes and
      // delivery/read receipts (no inbound message body).
      if (ev?.message?.is_echo) continue;
      if (!ev?.message && !ev?.postback) continue;

      const senderId = ev?.sender?.id ? String(ev.sender.id) : null;
      const recipientId = ev?.recipient?.id ? String(ev.recipient.id) : null;
      if (!senderId) continue;

      // Tenant: recipient is the Page id (Messenger). For IG, fall back to the
      // env-configured linked Page. Reuses the Sprint-2 page→company map.
      const envPageId = getPageId();
      let companyId =
        (recipientId ? await getCompanyIdByPageId(recipientId) : null) ??
        (envPageId ? await getCompanyIdByPageId(envPageId) : null);

      if (!companyId) {
        await recordIntegrationEvent({
          companyId: null,
          platform: "meta",
          eventType: "meta_msg_webhook_invalid",
          errorCode: "NO_PAGE_MAPPING",
          errorMessage: `No company claims recipient ${recipientId ?? "(none)"} for ${channel}`,
          requestContext: { channel, recipientId },
        });
        continue;
      }

      try {
        const profileName = await fetchProfileName(senderId);
        const contactId = await findOrCreateContactByChannelIdentity(companyId, channel, senderId, profileName);
        const conversationId = await upsertConversation({
          companyId,
          channel,
          externalThreadId: senderId,
          contactId,
        });
        const { type, body, mediaUrl } = extractContent(ev);
        await appendMessage({
          conversationId,
          companyId,
          direction: "in",
          externalMessageId: ev.message?.mid ? String(ev.message.mid) : null,
          type,
          body,
          mediaUrl,
          status: "received",
          sentAt: ev.timestamp ? new Date(Number(ev.timestamp)) : null,
        });
        await touchInbound(conversationId);
        // Service desk: auto-create/reopen a ticket (inert unless enabled).
        void ensureTicketForInbound({
          companyId,
          channel,
          customerId: contactId,
          conversationId,
          subject: body,
        });
        // Cadence auto-exit on reply (Messenger/IG).
        if (contactId) void onContactReplied(companyId, contactId);
        await recordIntegrationEvent({
          companyId,
          platform: "meta",
          eventType: "meta_msg_in",
          requestContext: { conversationId, channel, type },
        });
      } catch (err) {
        await recordIntegrationEvent({
          companyId,
          platform: "meta",
          eventType: "meta_msg_webhook_invalid",
          errorCode: "INGEST_ERROR",
          errorMessage: (err as Error).message,
          requestContext: { channel, recipientId },
        });
      }
    }
  }
}
