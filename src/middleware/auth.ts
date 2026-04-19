import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../utils/jwt";
import type { AuthenticatedRequest } from "../types";

// ============================================================================
// AUTHENTICATION MIDDLEWARE
// ============================================================================
// Verifies JWT access token and attaches user info to req.user.
// Use this on any route that requires authentication.
// ============================================================================

export function authenticateToken(
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
          message: "Access token is required",
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
          message: "Access token is required",
        },
      });
      return;
    }

    const decoded = verifyAccessToken(token);

    // Attach user to request
    (req as AuthenticatedRequest).user = {
      userId: decoded.userId,
      companyId: decoded.companyId,
      email: decoded.email,
      role: decoded.role as "owner" | "admin" | "manager" | "member",
    };

    next();
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "TOKEN_EXPIRED") {
        res.status(401).json({
          success: false,
          error: {
            code: "TOKEN_EXPIRED",
            message: "Access token has expired",
          },
        });
        return;
      }
      if (error.message === "INVALID_TOKEN") {
        res.status(401).json({
          success: false,
          error: {
            code: "INVALID_TOKEN",
            message: "Invalid access token",
          },
        });
        return;
      }
    }
    res.status(401).json({
      success: false,
      error: {
        code: "UNAUTHENTICATED",
        message: "Authentication failed",
      },
    });
    return;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Role-Based Access Control (RBAC)
// ─────────────────────────────────────────────────────────────────────────
export function requireRole(
  ...allowedRoles: Array<"owner" | "admin" | "manager" | "member">
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authReq = req as AuthenticatedRequest;

    if (!authReq.user) {
      res.status(401).json({
        success: false,
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        },
      });
      return;
    }

    if (!allowedRoles.includes(authReq.user.role)) {
      res.status(403).json({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: `This action requires one of these roles: ${allowedRoles.join(", ")}`,
        },
      });
      return;
    }

    next();
  };
}