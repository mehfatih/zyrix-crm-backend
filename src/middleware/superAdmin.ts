import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../utils/jwt";
import type { AuthenticatedRequest, UserRole } from "../types";

// ============================================================================
// SUPER ADMIN MIDDLEWARE
// ============================================================================
// Verifies the user is authenticated AND has role === "super_admin".
// Use on all /api/admin/* routes (except /api/admin/login and /api/admin/bootstrap).
// ============================================================================

export function requireSuperAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({
        success: false,
        error: {
          code: "UNAUTHENTICATED",
          message: "Admin access token is required",
        },
      });
      return;
    }

    const token = authHeader.substring(7);

    if (!token) {
      res.status(401).json({
        success: false,
        error: {
          code: "UNAUTHENTICATED",
          message: "Admin access token is required",
        },
      });
      return;
    }

    const decoded = verifyAccessToken(token);

    if (decoded.role !== "super_admin") {
      res.status(403).json({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: "Super admin privileges required",
        },
      });
      return;
    }

    (req as AuthenticatedRequest).user = {
      userId: decoded.userId,
      companyId: decoded.companyId,
      email: decoded.email,
      role: decoded.role as UserRole,
    };

    next();
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "TOKEN_EXPIRED") {
        res.status(401).json({
          success: false,
          error: {
            code: "TOKEN_EXPIRED",
            message: "Admin access token has expired",
          },
        });
        return;
      }
      if (error.message === "INVALID_TOKEN") {
        res.status(401).json({
          success: false,
          error: {
            code: "INVALID_TOKEN",
            message: "Invalid admin access token",
          },
        });
        return;
      }
    }
    res.status(401).json({
      success: false,
      error: {
        code: "UNAUTHENTICATED",
        message: "Admin authentication failed",
      },
    });
    return;
  }
}
