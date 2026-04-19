import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types";

// ============================================================================
// MULTI-TENANT MIDDLEWARE
// ============================================================================
// Ensures that a user can only access resources belonging to their company.
// Must be used AFTER authenticateToken.
// ============================================================================

export function enforceTenant(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  const authReq = req as AuthenticatedRequest;

  // If the request body has a companyId, ensure it matches the user's company
  if (req.body && typeof req.body === "object" && "companyId" in req.body) {
    req.body.companyId = authReq.user.companyId;
  }

  // If the query has a companyId, ensure it matches the user's company
  if (req.query.companyId) {
    req.query.companyId = authReq.user.companyId;
  }

  next();
}

// ─────────────────────────────────────────────────────────────────────────
// Extract Company ID from authenticated request
// ─────────────────────────────────────────────────────────────────────────
export function getCompanyId(req: Request): string {
  const authReq = req as AuthenticatedRequest;
  return authReq.user.companyId;
}