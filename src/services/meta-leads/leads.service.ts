// ============================================================================
// META LEAD ADS — imported-leads listing (read model for the web settings panel)
// ----------------------------------------------------------------------------
// Joins lead_sources → customers + deals so the UI can show recent leads with
// their attribution (campaign/ad/form/platform) and a link to the deal.
// ============================================================================

import { prisma } from "../../config/database";

export interface ImportedLeadRow {
  id: string;
  leadgenId: string;
  source: string;
  campaignId: string | null;
  adsetId: string | null;
  adId: string | null;
  formId: string | null;
  pageId: string | null;
  platform: string | null;
  createdAt: Date;
  contactId: string | null;
  contactName: string | null;
  dealId: string | null;
  dealStage: string | null;
}

export async function listLeads(
  companyId: string,
  opts: { limit?: number } = {}
): Promise<ImportedLeadRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  return (await prisma.$queryRawUnsafe(
    `SELECT ls."id", ls."leadgenId", ls."source", ls."campaignId", ls."adsetId",
            ls."adId", ls."formId", ls."pageId", ls."platform", ls."createdAt",
            ls."contactId", c."fullName" AS "contactName",
            ls."dealId", d."stage" AS "dealStage"
       FROM lead_sources ls
       LEFT JOIN customers c ON c."id" = ls."contactId"
       LEFT JOIN deals d ON d."id" = ls."dealId"
      WHERE ls."companyId" = $1
      ORDER BY ls."createdAt" DESC
      LIMIT ${limit}`,
    companyId
  )) as ImportedLeadRow[];
}

export async function countLeads(companyId: string, hours: number): Promise<number> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM lead_sources
      WHERE "companyId" = $1 AND "createdAt" >= NOW() - ($2 || ' hours')::interval`,
    companyId,
    String(hours)
  )) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}
