// ============================================================================
// META LEAD ADS — WEBHOOK verify + dispatch + ingest
// ----------------------------------------------------------------------------
// SHARED signature scheme with WhatsApp (same Meta app): X-Hub-Signature-256 =
// "sha256=" + hex(HMAC-SHA256(rawBody, META_APP_SECRET)). This receiver lives
// on its OWN callback URL (/api/integrations/meta/leads/webhook) and only
// processes object="page" changes with field="leadgen" — it never sees and
// never touches the WhatsApp `messages` webhook (separate URL + object).
//
// Flow per change: resolve tenant by page_id → fetch full lead by leadgen_id →
// map → contact+deal+attribution (idempotent) → integration_events.
// ============================================================================

import crypto from "crypto";
import { getAppSecret } from "./config";
import { getCompanyIdByPageId } from "./pages.service";
import { fetchLeadById } from "./fetch";
import { ingestLead } from "./map";
import { recordIntegrationEvent } from "../integration-events.service";

/** Verify X-Hub-Signature-256 against the raw body (shared with WhatsApp). */
export function verifySignature(rawBody: Buffer, header: string | undefined): boolean {
  const secret = getAppSecret();
  if (!secret || !header) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(header, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

interface LeadChangeValue {
  leadgen_id?: string;
  form_id?: string;
  page_id?: string;
  ad_id?: string;
  adgroup_id?: string;
  created_time?: number;
}

/**
 * Process a verified payload. Never throws (the controller already acked 200).
 * Dispatches by object/field: only object="page" + field="leadgen" is handled.
 */
export async function processWebhookPayload(payload: any): Promise<void> {
  // Only Page leadgen events. Ignore anything else (defensive — this URL is
  // dedicated, but a stray subscription shouldn't cause work or errors).
  if (!payload || payload.object !== "page") return;

  const entries: any[] = Array.isArray(payload.entry) ? payload.entry : [];
  for (const entry of entries) {
    const changes: any[] = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      if (change?.field !== "leadgen") continue;
      const value: LeadChangeValue = change?.value || {};
      const leadgenId = value.leadgen_id ? String(value.leadgen_id) : null;
      const pageId = value.page_id ? String(value.page_id) : entry?.id ? String(entry.id) : null;
      if (!leadgenId || !pageId) continue;

      const companyId = await getCompanyIdByPageId(pageId);
      if (!companyId) {
        await recordIntegrationEvent({
          companyId: null,
          platform: "meta",
          eventType: "meta_lead_webhook_invalid",
          errorCode: "NO_PAGE_MAPPING",
          errorMessage: `No company claims page_id ${pageId}`,
          requestContext: { pageId, leadgenId },
        });
        continue;
      }

      try {
        const lead = await fetchLeadById(leadgenId, pageId);
        const result = await ingestLead({ companyId, lead, pageId });
        await recordIntegrationEvent({
          companyId,
          platform: "meta",
          eventType: "meta_lead_received",
          requestContext: {
            leadgenId,
            pageId,
            formId: lead.formId,
            idempotent: result.idempotent,
            dealId: result.dealId,
          },
        });
      } catch (err) {
        const code =
          (err as { code?: string })?.code === "META_LEAD_TOKEN_EXPIRED"
            ? "META_LEAD_TOKEN_EXPIRED"
            : "META_LEAD_FETCH_FAILED";
        await recordIntegrationEvent({
          companyId,
          platform: "meta",
          eventType: "meta_lead_fetch_failed",
          errorCode: code,
          errorMessage: (err as Error).message,
          requestContext: { leadgenId, pageId },
        });
      }
    }
  }
}
