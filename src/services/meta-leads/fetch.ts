// ============================================================================
// META LEAD ADS — GRAPH FETCH
// ----------------------------------------------------------------------------
// The leadgen webhook only delivers IDs. To get the actual answers (PII) we
// call GET /{version}/{leadgen_id}?access_token={page_token}, which returns a
// `field_data` array plus campaign/ad attribution. Requires the approved
// `leads_retrieval` permission on the Page token.
// ============================================================================

import { integrationError } from "../../lib/errors/integrationErrors";
import { graphUrl } from "./config";
import { resolvePageToken } from "./pages.service";

const FETCH_TIMEOUT_MS = 15000;

export interface LeadFieldDatum {
  name: string; // the form field KEY (match on this, not the localized label)
  values: string[];
}

export interface FetchedLead {
  id: string;
  createdTime: string | null;
  fieldData: LeadFieldDatum[];
  formId: string | null;
  adId: string | null;
  adsetId: string | null;
  campaignId: string | null;
  platform: string | null; // fb | ig (best-effort from `platform` field)
  raw: Record<string, unknown>;
}

/**
 * Fetch a single lead's full payload by leadgen_id. Resolves the Page token
 * (per-Page sealed → env default). Throws typed errors at request time:
 *  • META_LEAD_TOKEN_EXPIRED  — no token available / Meta says token invalid
 *  • META_LEAD_FETCH_FAILED   — any other non-200 / network / timeout
 */
export async function fetchLeadById(leadgenId: string, pageId: string): Promise<FetchedLead> {
  const token = await resolvePageToken(pageId);
  if (!token) {
    throw integrationError("META_LEAD_TOKEN_EXPIRED", "No Page access token available for lead fetch", {
      platform: "meta",
      pageId,
    });
  }

  const fields = "id,created_time,field_data,ad_id,adset_id,campaign_id,form_id,platform";
  const url = `${graphUrl(encodeURIComponent(leadgenId))}?fields=${fields}&access_token=${encodeURIComponent(token)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(url, { method: "GET", signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw integrationError("META_LEAD_FETCH_FAILED", "Lead fetch timed out", { platform: "meta", leadgenId });
    }
    throw integrationError("META_LEAD_FETCH_FAILED", `Lead fetch failed: ${(err as Error).message}`, {
      platform: "meta",
      leadgenId,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    if (resp.status === 429) {
      throw integrationError("RATE_LIMITED", "Meta rate limited the lead fetch", { platform: "meta", leadgenId });
    }
    // 190 = invalid/expired OAuth token; 10/200 = permission problems
    if (resp.status === 401 || /\b190\b|access token/i.test(text)) {
      throw integrationError("META_LEAD_TOKEN_EXPIRED", `Page token rejected: ${text.slice(0, 200)}`, {
        platform: "meta",
        leadgenId,
      });
    }
    throw integrationError("META_LEAD_FETCH_FAILED", `Graph ${resp.status}: ${text.slice(0, 200)}`, {
      platform: "meta",
      leadgenId,
      status: resp.status,
    });
  }

  const json = (await resp.json()) as Record<string, unknown>;
  const fieldData = Array.isArray(json.field_data)
    ? (json.field_data as LeadFieldDatum[]).map((f) => ({
        name: String((f as { name?: unknown }).name ?? ""),
        values: Array.isArray((f as { values?: unknown }).values)
          ? ((f as { values: unknown[] }).values).map((v) => String(v))
          : [],
      }))
    : [];

  return {
    id: String(json.id ?? leadgenId),
    createdTime: json.created_time ? String(json.created_time) : null,
    fieldData,
    formId: json.form_id ? String(json.form_id) : null,
    adId: json.ad_id ? String(json.ad_id) : null,
    adsetId: json.adset_id ? String(json.adset_id) : null,
    campaignId: json.campaign_id ? String(json.campaign_id) : null,
    platform: json.platform ? String(json.platform) : null,
    raw: json,
  };
}
