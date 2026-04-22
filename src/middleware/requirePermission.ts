// ============================================================================
// REQUIRE PERMISSION MIDDLEWARE (P1)
// ----------------------------------------------------------------------------
// 403s when the authenticated user does not hold the specified permission(s).
// Runs after authenticateToken so req.user is populated.
//
// Usage:
//   router.get('/', authenticateToken, requirePermission('customers:read'), h);
//   router.post('/', authenticateToken, requirePermission(
//     'customers:write', 'customers:read'  // user needs BOTH
//   ), h);
//
// super_admin users (platform-owner JWT) bypass — they implicitly hold every
// permission. For endpoints that should be reachable ONLY by super_admin,
// keep using requireRole('super_admin') instead.
// ============================================================================

import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { AuthenticatedRequest } from "../types";
import { userHasAllPermissions } from "../services/rbac.service";
import type { Permission } from "../constants/permissions";

export function requirePermission(...required: Permission[]): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authReq = req as AuthenticatedRequest;
      if (!authReq.user) {
        return res.status(401).json({
          success: false,
          error: {
            code: "UNAUTHENTICATED",
            message: "Authentication required",
          },
        });
      }

      const ok = await userHasAllPermissions(
        authReq.user.userId,
        required,
        authReq.user.role
      );

      if (!ok) {
        return res.status(403).json({
          success: false,
          error: {
            code: "FORBIDDEN",
            message: `This action requires permission: ${required.join(", ")}`,
            requiredPermissions: required,
          },
        });
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
