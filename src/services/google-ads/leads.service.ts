// ============================================================================
// GOOGLE ADS LEAD FORMS — recent imported-leads listing (read model for UI)
// ----------------------------------------------------------------------------
// Joins lead_sources → customers + deals filtered to source='google_ads_lead'
// so the settings panel can show recent leads with attribution (campaign /
// adgroup / creative / gclid), the TEST badge (rawJson.isTest), and a link to
// the created deal. Mirrors services/meta-leads/leads.service.ts.
// ============================================================================

import { prisma } from "../../config/database";

export interface GoogleAdsLeadRow {
  id: string;
  leadgenId: string;
  campaignId: string | null;
  adgroupId: string | null; // stored in lead_sources.adsetId
  creativeId: string | null; // stored in lead_sources.adId
  formId: string | null;
  gclid: string | null; // from rawJson
  isTest: boolean; // from rawJson
  createdAt: Date;
  contactId: string | null;
  contactName: string | null;
  dealId: string | null;
  dealStage: string | null;
}

export async function listRecentLeads(
  companyId: string,
  opts: { limit?: number } = {}
): Promise<GoogleAdsLeadRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT ls."id", ls."leadgenId", ls."campaignId",
            ls."adsetId"  AS "adgroupId",
            ls."adId"     AS "creativeId",
            ls."formId",
            (ls."rawJson"->>'gclid')  AS "gclid",
            COALESCE((ls."rawJson"->>'isTest')::boolean, false) AS "isTest",
            ls."createdAt",
            ls."contactId", c."fullName" AS "contactName",
            ls."dealId", d."stage" AS "dealStage"
       FROM lead_sources ls
       LEFT JOIN customers c ON c."id" = ls."contactId"
       LEFT JOIN deals d ON d."id" = ls."dealId"
      WHERE ls."companyId" = $1 AND ls."source" = 'google_ads_lead'
      ORDER BY ls."createdAt" DESC
      LIMIT ${limit}`,
    companyId
  )) as GoogleAdsLeadRow[];
  return rows;
}
