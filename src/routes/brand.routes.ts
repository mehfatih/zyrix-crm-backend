import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import { requirePermission } from "../middleware/requirePermission";
import * as ctrl from "../controllers/brand.controller";

// ============================================================================
// BRAND / WHITE-LABEL ROUTES (mounted at /api/brand)
// ----------------------------------------------------------------------------
// Public route (getPublic) registered BEFORE the auth middleware so it
// can serve the login-page branding without a session token.
// ============================================================================

const router = Router();

// Public — read-only, by domain
router.get("/public", ctrl.getPublic);

// Session-authed from here down
router.use(authenticateToken);

router.get("/", ctrl.get);
router.patch("/", requirePermission("settings:branding"), ctrl.update);
router.delete("/", requirePermission("settings:branding"), ctrl.reset);

// Custom domain (enterprise)
router.post("/domain", requirePermission("settings:branding"), ctrl.setDomain);
router.post(
  "/domain/verify",
  requirePermission("settings:branding"),
  ctrl.verifyDomain
);
router.delete("/domain", requirePermission("settings:branding"), ctrl.removeDomain);

export default router;
