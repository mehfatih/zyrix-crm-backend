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

import type { RequestHandler } from "express";
import { requireFeature } from "./entitlement-gate";

// Sprint 16B: gateFeature now delegates to the entitlement gate so every
// existing gate is flag-controlled (ENTITLEMENTS_ENFORCE). With the flag OFF
// (default/prod today) it is a pass-through; with it ON it returns the same
// 403 FEATURE_DISABLED shape (now enriched with `requiredPlan`). Kept as a
// named export so the ~25 existing `gateFeature("x")` call sites are unchanged.
export function gateFeature(key: string): RequestHandler {
  return requireFeature(key);
}
