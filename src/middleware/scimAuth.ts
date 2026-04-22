// ============================================================================
// SCIM AUTH MIDDLEWARE (P7)
// ----------------------------------------------------------------------------
// Validates Bearer tokens against ScimToken table and attaches companyId to
// req.user. No JWT path — SCIM is IdP-only.
// ============================================================================

import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { AuthenticatedRequest } from "../types";
import { verifyScimToken } from "../services/scim.service";

export function authenticateScim(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
        status: "401",
        detail: "Bearer token required",
      });
    }
    const token = header.substring(7).trim();
    const ctx = await verifyScimToken(token);
    if (!ctx) {
      return res.status(401).json({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
        status: "401",
        detail: "Invalid or revoked SCIM token",
      });
    }
    (req as AuthenticatedRequest).user = {
      userId: `scim:${ctx.id}`,
      companyId: ctx.companyId,
      email: "",
      role: "scim_token" as any,
    };
    next();
  };
}
