// ============================================================================
// COMPLIANCE AUTH MIDDLEWARE (P6)
// ----------------------------------------------------------------------------
// Dual-mode authentication for /api/compliance/*:
//   • Merchant owner with admin:compliance permission via JWT
//   • External auditor with a bearer token issued via /settings/compliance
//
// Either path resolves req.user to a synthetic { companyId, userId } the
// downstream handlers already expect; real JWTs also populate email and
// role. Compliance token callers get role='compliance_token' which
// requirePermission would never let through by accident.
// ============================================================================

import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { AuthenticatedRequest } from "../types";
import { verifyAccessToken } from "../utils/jwt";
import { verifyComplianceToken } from "../services/compliance.service";
import { userHasAllPermissions } from "../services/rbac.service";

export function authenticateCompliance(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: {
          code: "UNAUTHENTICATED",
          message: "A Bearer token is required",
        },
      });
    }
    const token = header.substring(7).trim();

    // 1. Compliance token path — prefix-match lets us skip JWT verify
    if (token.startsWith("comp_")) {
      const ctx = await verifyComplianceToken(token);
      if (!ctx) {
        return res.status(401).json({
          success: false,
          error: {
            code: "INVALID_COMPLIANCE_TOKEN",
            message: "Compliance token is invalid or revoked",
          },
        });
      }
      (req as AuthenticatedRequest).user = {
        userId: `compliance:${ctx.id}`,
        companyId: ctx.companyId,
        email: "",
        role: "compliance_token" as any,
      };
      return next();
    }

    // 2. JWT path — require admin:compliance permission
    try {
      const decoded = verifyAccessToken(token);
      (req as AuthenticatedRequest).user = {
        userId: decoded.userId,
        companyId: decoded.companyId,
        email: decoded.email,
        role: decoded.role as any,
      };
      const ok = await userHasAllPermissions(
        decoded.userId,
        ["admin:compliance"],
        decoded.role
      );
      if (!ok) {
        return res.status(403).json({
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "admin:compliance permission required",
          },
        });
      }
      return next();
    } catch {
      return res.status(401).json({
        success: false,
        error: {
          code: "UNAUTHENTICATED",
          message: "Invalid access token",
        },
      });
    }
  };
}
