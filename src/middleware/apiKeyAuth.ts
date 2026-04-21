import type { Request, Response, NextFunction } from "express";
import { authenticateApiKey } from "../services/api-keys.service";
import type { AuthenticatedRequest } from "../types";

// ============================================================================
// API KEY AUTHENTICATION MIDDLEWARE
// ----------------------------------------------------------------------------
// For public /v1 endpoints. Reads Authorization: Bearer <key>, validates
// against api_keys table, attaches user context to req.user in the same
// shape as session auth — so downstream controllers don't need two branches.
//
// Scope gate: if requireWrite=true and the key is read-only, reject with 403.
// ============================================================================

export interface ApiKeyAuthOptions {
  requireWrite?: boolean;
}

export function authenticateApiKeyMiddleware(options?: ApiKeyAuthOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.header("authorization") || req.header("Authorization");
    if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
      return res.status(401).json({
        success: false,
        error: {
          code: "MISSING_API_KEY",
          message: "Missing Authorization header. Use: Authorization: Bearer zy_live_...",
        },
      });
    }

    const key = authHeader.slice(7).trim();
    if (!key) {
      return res.status(401).json({
        success: false,
        error: {
          code: "MISSING_API_KEY",
          message: "API key is empty",
        },
      });
    }

    const auth = await authenticateApiKey(key);
    if (!auth) {
      return res.status(401).json({
        success: false,
        error: {
          code: "INVALID_API_KEY",
          message: "Invalid or revoked API key",
        },
      });
    }

    if (options?.requireWrite && auth.scope !== "write") {
      return res.status(403).json({
        success: false,
        error: {
          code: "INSUFFICIENT_SCOPE",
          message: "This endpoint requires a write-scoped API key",
        },
      });
    }

    // Attach user context in the same shape as session auth so
    // controllers can treat req.user uniformly. The API key acts on
    // behalf of its creator — we reuse their userId + role so existing
    // role-gated controllers (listCustomers, etc.) Just Work.
    (req as AuthenticatedRequest).user = {
      userId: auth.createdById,
      companyId: auth.companyId,
      email: "api-key@zyrix.co", // sentinel — not used for auth decisions
      role: "admin", // API keys act with admin-level access within their company
    };
    // Stash the actual key id separately on the request for audit logging.
    (req as any).apiKeyId = auth.keyId;
    (req as any).apiKeyScope = auth.scope;
    next();
  };
}
