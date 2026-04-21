// ============================================================================
// FEATURE GATE MIDDLEWARE
// ----------------------------------------------------------------------------
// Returns 403 when the authenticated company has the specified feature
// disabled. Mount on routes whose access should respect per-merchant
// feature toggles configured by the Zyrix platform owner in the admin
// panel.
//
// Usage:
//   router.use(authenticateToken);
//   router.use(gateFeature('quotes'));
//   router.get('/', quotes.list);
// ============================================================================

import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { AuthenticatedRequest } from "../types";
import { isFeatureEnabled } from "../services/feature-flags.service";

export function gateFeature(key: string): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const companyId = authReq.user?.companyId;
      if (!companyId) {
        // Auth middleware should run first — if we got here without a
        // companyId, let the downstream handler fail normally.
        return next();
      }
      const enabled = await isFeatureEnabled(companyId, key);
      if (!enabled) {
        return res.status(403).json({
          success: false,
          error: {
            code: "FEATURE_DISABLED",
            message: `The '${key}' feature is not enabled for this account.`,
            feature: key,
          },
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
