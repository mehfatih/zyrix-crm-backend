// ============================================================================
// WHATSAPP WEBHOOK — signature verify + parse + ingest
// ----------------------------------------------------------------------------
// X-Hub-Signature-256 = "sha256=" + hex( HMAC-SHA256( rawBody, META_APP_SECRET ) ).
// Inbound messages → match/create contact by phone → upsert conversation +
// message → open 24h window → log integration_events. Status callbacks update
// message delivery state. Never logs tokens or message bodies as secrets.
// ============================================================================

import crypto from "crypto";
import { getAppSecret } from "./config";
import { getCompanyIdByPhoneNumberId } from "./numbers.service";
import {
  findOrCreateContactByPhone,
  upsertConversation,
  appendMessage,
  touchInbound,
  updateMessageStatusByExternalId,
} from "./conversations.service";
import { recordIntegrationEvent } from "../integration-events.service";
import { onContactReplied } from "../cadence.service";
import { ensureTicketForInbound } from "../ticket.service";

/** Verify the X-Hub-Signature-256 header against the raw body. */
export function verifySignature(rawBody: Buffer, header: string | undefined): boolean {
  const secret = getAppSecret();
  if (!secret || !header) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(header, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Map a WhatsApp inbound message object to { type, body, mediaUrl }.
function extractContent(msg: any): { type: string; body: string | null; mediaUrl: string | null } {
  const type = msg.type || "text";
  switch (type) {
    case "text":
      return { type, body: msg.text?.body ?? null, mediaUrl: null };
    case "image":
    case "document":
    case "audio":
    case "video":
    case "sticker": {
      const media = msg[type] || {};
      // Cloud API returns a media id; resolving to a downloadable URL needs a
      // separate Graph call (token) — deferred; we keep the id for later fetch.
      return { type, body: media.caption ?? `[${type}]`, mediaUrl: media.id ? String(media.id) : null };
    }
    case "location": {
      const loc = msg.location || {};
      const label = [loc.name, loc.address].filter(Boolean).join(" · ");
      return { type, body: label || `${loc.latitude},${loc.longitude}`, mediaUrl: null };
    }
    case "interactive": {
      const i = msg.interactive || {};
      const title = i.button_reply?.title || i.list_reply?.title || i.nfm_reply?.body || null;
      return { type, body: title, mediaUrl: null };
    }
    case "button":
      return { type, body: msg.button?.text ?? null, mediaUrl: null };
    default:
      return { type, body: `[${type}]`, mediaUrl: null };
  }
}

/**
 * Process a verified webhook payload. Never throws (the controller already
 * acked 200). Returns counts for logging.
 */
export async function processWebhookPayload(payload: any): Promise<void> {
  const entries: any[] = Array.isArray(payload?.entry) ? payload.entry : [];
  for (const entry of entries) {
    const changes: any[] = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value || {};
      const phoneNumberId: string | undefined = value?.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      const companyId = await getCompanyIdByPhoneNumberId(phoneNumberId);
      if (!companyId) {
        await recordIntegrationEvent({
          companyId: null,
          platform: "whatsapp",
          eventType: "webhook_failed",
          errorCode: "NO_NUMBER_MAPPING",
          errorMessage: `No company claims phone_number_id ${phoneNumberId}`,
          requestContext: { phoneNumberId },
        });
        continue;
      }

      // Profile names (wa_id → display name) for nicer contact creation.
      const names = new Map<string, string>();
      for (const c of (Array.isArray(value.contacts) ? value.contacts : [])) {
        if (c?.wa_id && c?.profile?.name) names.set(String(c.wa_id), String(c.profile.name));
      }

      // ── Inbound messages ──────────────────────────────────────────────
      for (const msg of (Array.isArray(value.messages) ? value.messages : [])) {
        try {
          const from = String(msg.from);
          const contactId = await findOrCreateContactByPhone(companyId, from, names.get(from));
          const conversationId = await upsertConversation({
            companyId,
            channel: "whatsapp",
            externalThreadId: from,
            contactId,
          });
          const { type, body, mediaUrl } = extractContent(msg);
          await appendMessage({
            conversationId,
            companyId,
            direction: "in",
            externalMessageId: msg.id ? String(msg.id) : null,
            type,
            body,
            mediaUrl,
            status: "received",
            sentAt: msg.timestamp ? new Date(Number(msg.timestamp) * 1000) : null,
          });
          await touchInbound(conversationId);
          // Service desk: auto-create/reopen a ticket (inert unless enabled).
          void ensureTicketForInbound({
            companyId,
            channel: "whatsapp",
            customerId: contactId,
            conversationId,
            subject: body,
          });
          // Cadence auto-exit: a reply ends active enrollments (onReply rule).
          if (contactId) void onContactReplied(companyId, contactId);
          await recordIntegrationEvent({
            companyId,
            platform: "whatsapp",
            eventType: "whatsapp_message_in",
            requestContext: { conversationId, type, from },
          });
        } catch (err) {
          await recordIntegrationEvent({
            companyId,
            platform: "whatsapp",
            eventType: "webhook_failed",
            errorCode: "INGEST_ERROR",
            errorMessage: (err as Error).message,
            requestContext: { phoneNumberId },
          });
        }
      }

      // ── Delivery status callbacks ─────────────────────────────────────
      for (const st of (Array.isArray(value.statuses) ? value.statuses : [])) {
        try {
          if (!st.id) continue;
          const errorDetail = Array.isArray(st.errors) && st.errors[0]
            ? String(st.errors[0].title || st.errors[0].message || "")
            : null;
          await updateMessageStatusByExternalId(String(st.id), String(st.status || "sent"), errorDetail);
          if (st.status === "failed") {
            await recordIntegrationEvent({
              companyId,
              platform: "whatsapp",
              eventType: "whatsapp_send_failed",
              errorCode: "DELIVERY_FAILED",
              errorMessage: errorDetail ?? "delivery failed",
              requestContext: { externalMessageId: String(st.id) },
            });
          }
        } catch {
          /* status update best-effort */
        }
      }
    }
  }
}
