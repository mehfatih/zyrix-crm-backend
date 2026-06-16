// ============================================================================
// DEAL ATTRIBUTION CONTROLLER (Sprint 25 Phase B) — manual source stamp.
// GET /api/deals/:id/attribution    → current stamp + linked campaign
// PUT /api/deals/:id/attribution    → set/clear the MANUAL source (+ optional
//                                      ad-campaign link). Manual always wins.
// Gated by the `source_attribution` entitlement (STARTER_UP) at the route layer.
// ============================================================================

import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as attribution from "../services/deal-attribution.service";
import { AttributionError } from "../services/deal-attribution.service";
import { ATTRIBUTION_SOURCES } from "../services/attribution";
import type { AuthenticatedRequest } from "../types";
import { badRequest, notFound } from "../middleware/errorHandler";

// source: a known token, or null/'' to clear. adCampaignId: a string to link, or
// null/'' to unlink, or omitted to leave the existing link untouched.
const setSchema = z.object({
  source: z
    .union([z.enum(ATTRIBUTION_SOURCES), z.literal(""), z.null()])
    .optional(),
  adCampaignId: z.union([z.string(), z.null()]).optional(),
});

function getDealId(req: Request): string {
  const value = req.params.id;
  if (!value) throw badRequest("Missing parameter: id");
  return Array.isArray(value) ? value[0] : value;
}

export async function getAttribution(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const data = await attribution.getDealAttribution(
      authReq.user.companyId,
      getDealId(req)
    );
    if (!data) throw notFound("Deal");
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

export async function setAttribution(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const dto = setSchema.parse(req.body);
    const data = await attribution.setManualAttribution(
      authReq.user.companyId,
      getDealId(req),
      dto
    );
    if (!data) throw notFound("Deal");
    res.json({ success: true, data, message: "Attribution updated" });
  } catch (error) {
    if (error instanceof AttributionError) {
      return next(badRequest(error.message));
    }
    next(error);
  }
}
