import type { Request, Response } from "express";
import { verifyKeyAndResolve } from "../../services/google-ads/config.service";
import { ingestGoogleLead, type GoogleLeadPayload } from "../../services/google-ads/map";
import { recordIntegrationEvent } from "../../services/integration-events.service";

// ============================================================================
// GOOGLE ADS LEAD FORMS WEBHOOK RECEIVER
//   POST /api/integrations/google-ads/leads/webhook/:companyId
// ----------------------------------------------------------------------------
// PUBLIC (no session). The company is in the URL (Google's payload carries no
// tenant id); the shared secret arrives in the body as `google_key` and is
// validated against the company's sealed webhookKey with a constant-time
// compare. Unlike Meta this is self-contained — the full lead is in the POST,
// so there's no Graph fetch: verify → ack 200 fast → ingest inline (detached).
// Never logs the key or lead PII as secrets.
// ============================================================================

/** GET — a friendly readiness ping (some gateways probe the URL with GET). */
export function ready(_req: Request, res: Response): void {
  res
    .status(200)
    .json({ success: true, message: "Google Ads Lead Form webhook ready — use POST" });
}

/** POST — verify google_key, ack 200, then ingest the (complete) lead. */
export async function receive(req: Request, res: Response): Promise<void> {
  const companyId = typeof req.params.companyId === "string" ? req.params.companyId : "";
  const body = (req.body ?? {}) as GoogleLeadPayload;
  const providedKey = typeof body.google_key === "string" ? body.google_key : undefined;

  let resolved: Awaited<ReturnType<typeof verifyKeyAndResolve>> = null;
  try {
    resolved = await verifyKeyAndResolve(companyId, providedKey);
  } catch (e) {
    // Unexpected (e.g. DB) error during verification — fail closed.
    res
      .status(500)
      .json({ success: false, error: { code: "INTERNAL_ERROR", message: "Verification failed" } });
    void recordIntegrationEvent({
      companyId: companyId || null,
      platform: "google_ads",
      eventType: "google_ads_lead_invalid",
      errorCode: "GOOGLE_ADS_VERIFY_ERROR",
      errorMessage: (e as Error).message,
      requestContext: { route: req.originalUrl },
    });
    return;
  }

  if (!resolved) {
    void recordIntegrationEvent({
      companyId: companyId || null,
      platform: "google_ads",
      eventType: "google_ads_lead_invalid",
      errorCode: "GOOGLE_ADS_KEY_INVALID",
      errorMessage: "Invalid/missing google_key or integration disabled",
      requestContext: { route: req.originalUrl, formId: body.form_id, isTest: body.is_test === true },
    });
    res
      .status(403)
      .json({ success: false, error: { code: "GOOGLE_ADS_KEY_INVALID", message: "Invalid key" } });
    return;
  }

  // Ack within Google's timeout, then process — the payload is complete.
  res.status(200).json({ success: true });

  const company = resolved.companyId;
  const mapping = resolved.mapping;
  const stage = resolved.defaultPipelineStage;
  void ingestGoogleLead({ companyId: company, payload: body, mapping, defaultPipelineStage: stage })
    .then((result) =>
      recordIntegrationEvent({
        companyId: company,
        platform: "google_ads",
        eventType: "google_ads_lead_received",
        requestContext: {
          leadId: body.lead_id,
          formId: body.form_id,
          campaignId: body.campaign_id,
          isTest: result.isTest,
          idempotent: result.idempotent,
          dealId: result.dealId,
        },
      })
    )
    .catch((e) =>
      recordIntegrationEvent({
        companyId: company,
        platform: "google_ads",
        eventType: "google_ads_lead_invalid",
        errorCode: "GOOGLE_ADS_INGEST_FAILED",
        errorMessage: (e as Error).message,
        requestContext: { leadId: body.lead_id, formId: body.form_id },
      })
    );
}
