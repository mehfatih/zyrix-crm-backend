// ============================================================================
// DEAL ATTRIBUTION (Sprint 25) — read/write the deal's source stamp (raw SQL).
// ----------------------------------------------------------------------------
// The two attribution columns on `deals` are raw (NOT in the Prisma model), so
// everything here goes through $queryRawUnsafe / $executeRawUnsafe — exactly like
// the Sprint-24 deals.adCampaignId tag and the campaign-economics tables.
//
// PRECEDENCE (locked rule #4): a MANUAL stamp is NEVER overwritten by auto. Auto
// capture (Phases C/D/E) still writes its lead_sources audit row, but only stamps
// the deal when there's no manual stamp already. The manual setter (Phase B) is
// the user's explicit action and always wins.
// ============================================================================

import { prisma } from "../config/database";
import {
  coerceSource,
  type AttributionSource,
  type CaptureMethod,
} from "./attribution";

export class AttributionError extends Error {}

export interface DealAttribution {
  dealId: string;
  source: AttributionSource | null;
  captureMethod: CaptureMethod | null;
  adCampaignId: string | null;
  adCampaignName: string | null; // resolved label when a campaign is linked
}

function mapRow(r: Record<string, unknown>): DealAttribution {
  return {
    dealId: String(r.id),
    source: (coerceSource(r.attributionSource) ?? null),
    captureMethod:
      r.attributionCaptureMethod === "manual"
        ? "manual"
        : r.attributionCaptureMethod === "auto"
          ? "auto"
          : null,
    adCampaignId: (r.adCampaignId as string | null) ?? null,
    adCampaignName: (r.adCampaignName as string | null) ?? null,
  };
}

/** Read a deal's attribution stamp (+ linked campaign name). null if no such deal. */
export async function getDealAttribution(
  companyId: string,
  dealId: string
): Promise<DealAttribution | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT d."id", d."attributionSource", d."attributionCaptureMethod", d."adCampaignId",
            c."name" AS "adCampaignName"
       FROM deals d
       LEFT JOIN ad_campaigns c
         ON c."id" = d."adCampaignId" AND c."companyId" = d."companyId"
      WHERE d."companyId" = $1 AND d."id" = $2
      LIMIT 1`,
    companyId,
    dealId
  )) as Array<Record<string, unknown>>;
  return rows[0] ? mapRow(rows[0]) : null;
}

export interface ManualAttributionInput {
  source?: string | null; // null/'' clears the stamp
  adCampaignId?: string | null; // optional campaign link (Sprint-24 column)
}

/**
 * Set a deal's MANUAL source stamp. Always allowed (explicit user action) — wins
 * over any prior auto stamp. Passing source=null/'' clears the stamp. An optional
 * adCampaignId links the deal to an ad campaign (must belong to the company);
 * pass null to unlink. Returns null when the deal doesn't exist for this company;
 * throws AttributionError on an unknown source or a foreign campaign id.
 */
export async function setManualAttribution(
  companyId: string,
  dealId: string,
  input: ManualAttributionInput
): Promise<DealAttribution | null> {
  const existing = await getDealAttribution(companyId, dealId);
  if (!existing) return null;

  // Resolve the source: explicit clear vs a validated token.
  const raw = input.source;
  let source: AttributionSource | null;
  if (raw == null || (typeof raw === "string" && raw.trim() === "")) {
    source = null;
  } else {
    source = coerceSource(raw);
    if (!source) throw new AttributionError(`Unknown attribution source: ${String(raw)}`);
  }

  // Resolve the optional campaign link. undefined → leave as-is; null/'' → unlink;
  // a value → must be one of this company's campaigns.
  let adCampaignId: string | null | undefined = undefined;
  if (input.adCampaignId !== undefined) {
    const v = input.adCampaignId;
    if (v == null || v === "") {
      adCampaignId = null;
    } else {
      const found = (await prisma.$queryRawUnsafe(
        `SELECT 1 FROM ad_campaigns WHERE "companyId" = $1 AND "id" = $2 LIMIT 1`,
        companyId,
        v
      )) as Array<unknown>;
      if (found.length === 0) throw new AttributionError("Campaign not found");
      adCampaignId = v;
    }
  }

  // Clearing the source also resets the capture method to NULL.
  const captureMethod: CaptureMethod | null = source ? "manual" : null;

  if (adCampaignId === undefined) {
    await prisma.$executeRawUnsafe(
      `UPDATE deals
          SET "attributionSource" = $3, "attributionCaptureMethod" = $4, "updatedAt" = NOW()
        WHERE "companyId" = $1 AND "id" = $2`,
      companyId,
      dealId,
      source,
      captureMethod
    );
  } else {
    await prisma.$executeRawUnsafe(
      `UPDATE deals
          SET "attributionSource" = $3, "attributionCaptureMethod" = $4,
              "adCampaignId" = $5, "updatedAt" = NOW()
        WHERE "companyId" = $1 AND "id" = $2`,
      companyId,
      dealId,
      source,
      captureMethod,
      adCampaignId
    );
  }

  return getDealAttribution(companyId, dealId);
}

/**
 * Stamp a deal's source from AUTO capture (Phases C/D/E), respecting manual
 * precedence: if the deal already carries a MANUAL stamp, the deal columns are
 * left untouched (the caller still writes its lead_sources audit row). Returns
 * true when the deal stamp was written, false when skipped (manual present / no
 * deal / bad source). Never throws on a bad source — auto paths are fire-safe.
 */
export async function stampAttributionAuto(
  companyId: string,
  dealId: string,
  rawSource: string,
  adCampaignId?: string | null
): Promise<boolean> {
  const source = coerceSource(rawSource);
  if (!source) return false;

  // Only stamp when there's no manual stamp already. One conditional UPDATE keeps
  // it race-safe (no read-then-write window).
  const setCampaign =
    adCampaignId != null && adCampaignId !== "" ? adCampaignId : null;

  const affected = (await prisma.$executeRawUnsafe(
    `UPDATE deals
        SET "attributionSource" = $3,
            "attributionCaptureMethod" = 'auto',
            "adCampaignId" = COALESCE("adCampaignId", $4),
            "updatedAt" = NOW()
      WHERE "companyId" = $1 AND "id" = $2
        AND NOT ("attributionCaptureMethod" = 'manual' AND "attributionSource" IS NOT NULL)`,
    companyId,
    dealId,
    source,
    setCampaign
  )) as unknown;

  return Number(affected) > 0;
}
