import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticateApiKeyMiddleware } from "../middleware/apiKeyAuth";
import * as ctrl from "../controllers/public-api.controller";
import { getOpenApiSpec } from "../controllers/openapi.controller";

// ============================================================================
// PUBLIC API v1 ROUTES (mounted at /v1)
// ----------------------------------------------------------------------------
// Every route requires Authorization: Bearer zy_live_... header.
// Rate limited per API key: 600 req/minute (10/sec) — generous enough for
// most integrations, tight enough that a runaway Zapier zap can't DOS us.
// Write operations need scope='write'; reads are fine with either.
// ============================================================================

const perKeyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  keyGenerator: (req: any) => req.apiKeyId ?? req.ip ?? "unknown",
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: "RATE_LIMITED",
      message: "API key rate limit exceeded (600 req/min)",
    },
  },
});

const router = Router();

// OpenAPI spec is public (no auth) — must come BEFORE the rate limiter
// + auth middleware so API consumers can fetch the spec without a key.
router.get("/openapi.json", getOpenApiSpec);

// Order: rate limit first (it's cheap), auth second (DB call), then controller
router.use(perKeyLimiter);

// Auth test — needs read scope
router.get("/auth/test", authenticateApiKeyMiddleware(), ctrl.authTest);

// ─── Customers ───────────────────────────────────────────────────────
router.get("/customers", authenticateApiKeyMiddleware(), ctrl.listCustomersV1);
router.get(
  "/customers/:id",
  authenticateApiKeyMiddleware(),
  ctrl.getCustomerV1
);
router.post(
  "/customers",
  authenticateApiKeyMiddleware({ requireWrite: true }),
  ctrl.createCustomerV1
);
router.patch(
  "/customers/:id",
  authenticateApiKeyMiddleware({ requireWrite: true }),
  ctrl.updateCustomerV1
);
router.delete(
  "/customers/:id",
  authenticateApiKeyMiddleware({ requireWrite: true }),
  ctrl.deleteCustomerV1
);

// ─── Deals ──────────────────────────────────────────────────────────
router.get("/deals", authenticateApiKeyMiddleware(), ctrl.listDealsV1);
router.get("/deals/:id", authenticateApiKeyMiddleware(), ctrl.getDealV1);
router.post(
  "/deals",
  authenticateApiKeyMiddleware({ requireWrite: true }),
  ctrl.createDealV1
);
router.patch(
  "/deals/:id",
  authenticateApiKeyMiddleware({ requireWrite: true }),
  ctrl.updateDealV1
);

// ─── Activities ─────────────────────────────────────────────────────
router.post(
  "/activities",
  authenticateApiKeyMiddleware({ requireWrite: true }),
  ctrl.createActivityV1
);

export default router;
