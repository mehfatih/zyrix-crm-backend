// ============================================================================
// IP ALLOWLIST MIDDLEWARE (P4)
// ----------------------------------------------------------------------------
// Runs AFTER authenticateToken so we have req.user.companyId. If the
// company has any allowlist rules, the request's IP (extracted the
// same way extractRequestMeta does) must match at least one. Companies
// with zero rules opt out and are never blocked.
// ============================================================================

import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { AuthenticatedRequest } from "../types";
import { isIpAllowed } from "../services/ip-allowlist.service";

export function enforceIpAllowlist(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const companyId = authReq.user?.companyId;
      if (!companyId) return next();

      // Read the same way utils/audit.ts extractRequestMeta does —
      // proxy-aware thanks to app.set('trust proxy', 1) in index.ts.
      const ip = req.ip || null;
      const result = await isIpAllowed(companyId, ip);
      if (!result.allowed) {
        return res.status(403).json({
          success: false,
          error: {
            code: "IP_NOT_ALLOWED",
            message:
              result.reason ||
              "This network is not allowed to access the account. Contact your admin.",
            clientIp: ip,
          },
        });
      }
      next();
    } catch (err) {
      // Don't hard-fail requests because the allowlist check errored —
      // that would lock everyone out on a Prisma hiccup. Log + allow.
      console.error("[ipAllowlist] check failed (fail-open):", err);
      next();
    }
  };
}
