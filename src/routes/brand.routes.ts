import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
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
router.patch("/", ctrl.update);
router.delete("/", ctrl.reset);

// Custom domain (enterprise)
router.post("/domain", ctrl.setDomain);
router.post("/domain/verify", ctrl.verifyDomain);
router.delete("/domain", ctrl.removeDomain);

export default router;
