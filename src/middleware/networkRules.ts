// ============================================================================
// NETWORK RULES MIDDLEWARE (P8)
// ----------------------------------------------------------------------------
// Runs before auth. Blocks IPs matching an active geo_block rule, and
// enforces any matching rate_limit rules. Fail-open on service errors so
// a Prisma hiccup can't take the whole platform down.
// ============================================================================

import type { Request, Response, NextFunction, RequestHandler } from "express";
import { isIpBlocked, checkRateLimit } from "../services/network-rules.service";

export function networkRules(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ip = req.ip || null;
      if (ip) {
        if (await isIpBlocked(ip)) {
          return res.status(403).json({
            success: false,
            error: {
              code: "IP_BLOCKED",
              message: "Your IP is blocked by platform policy.",
            },
          });
        }
        const rl = await checkRateLimit(ip, req.path);
        if (!rl.allowed) {
          return res.status(429).json({
            success: false,
            error: {
              code: "RATE_LIMITED",
              message: "Too many requests. Slow down and retry.",
              windowMs: rl.windowMs,
              max: rl.max,
            },
          });
        }
      }
      next();
    } catch (err) {
      console.error("[networkRules] fail-open:", err);
      next();
    }
  };
}
