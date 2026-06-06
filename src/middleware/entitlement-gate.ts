// ============================================================================
// ENTITLEMENT GATE (Sprint 16B) — flag-gated feature + limit enforcement.
// ----------------------------------------------------------------------------
// requireFeature(key)            → 403 FEATURE_DISABLED when the company's plan
//                                  (or override) does not grant the feature.
// enforceLimit(key, countFn)     → 422 LIMIT_REACHED when current usage >= the
//                                  resolved numeric limit (null = unlimited).
//
// BOTH are gated by env ENTITLEMENTS_ENFORCE: resolution is always computed, but
// blocking only happens when the flag is "true". With the flag OFF (default,
// and prod today) these are pass-throughs — nothing is ever blocked. Mehmet
// flips the flag only after the grandfathering report is verified.
//
// The legacy gateFeature() (middleware/feature-gate.ts) now delegates here, so
// every existing gate becomes flag-controlled too.
// ============================================================================

import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { AuthenticatedRequest } from "../types";
import { env } from "../config/env";
import { resolveFeature } from "../services/entitlements.service";
import { FEATURE_CATALOG, type PlanSlug } from "../services/feature-flags.service";

export function isEnforcing(): boolean {
  return env.ENTITLEMENTS_ENFORCE === "true";
}

const PLAN_ORDER: PlanSlug[] = ["free", "starter", "business", "enterprise"];

/** Smallest plan tier that grants this feature (for the upsell hint). */
export function requiredPlanFor(key: string): PlanSlug | null {
  const def = FEATURE_CATALOG.find((f) => f.key === key);
  if (!def) return null;
  for (const p of PLAN_ORDER) {
    if (def.defaultByPlan[p] === true) return p;
  }
  return "enterprise";
}

function companyIdOf(req: Request): string | undefined {
  return (req as AuthenticatedRequest).user?.companyId;
}

function denyFeature(res: Response, key: string) {
  return res.status(403).json({
    success: false,
    error: {
      code: "FEATURE_DISABLED",
      message: `The '${key}' feature is not included in your current plan.`,
      feature: key,
      requiredPlan: requiredPlanFor(key),
    },
  });
}

/**
 * Block access to a feature the company's plan/override doesn't grant.
 * Pass-through when ENTITLEMENTS_ENFORCE is off.
 */
export function requireFeature(key: string): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = companyIdOf(req);
      if (!companyId) return next(); // auth handles missing company
      const ent = await resolveFeature(companyId, key);
      if (ent.enabled) return next();
      if (!isEnforcing()) return next(); // flag off → never block
      return denyFeature(res, key);
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Block a create action when current usage has reached the plan limit.
 * `countFn` returns the company's CURRENT count for the limited resource.
 * Pass-through when ENTITLEMENTS_ENFORCE is off (and skips the count query).
 */
export function enforceLimit(
  key: string,
  countFn: (companyId: string) => Promise<number>
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = companyIdOf(req);
      if (!companyId) return next();
      if (!isEnforcing()) return next(); // flag off → no block, no count
      const ent = await resolveFeature(companyId, key);
      if (!ent.enabled) return denyFeature(res, key); // feature itself not granted
      if (ent.limit === null) return next(); // unlimited
      const current = await countFn(companyId);
      if (current >= ent.limit) {
        return res.status(422).json({
          success: false,
          error: {
            code: "LIMIT_REACHED",
            message: `You've reached your plan limit of ${ent.limit} for '${key}'.`,
            feature: key,
            limit: ent.limit,
            current,
            requiredPlan: requiredPlanFor(key),
          },
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
