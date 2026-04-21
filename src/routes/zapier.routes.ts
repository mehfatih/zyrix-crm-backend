import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticateApiKeyMiddleware } from "../middleware/apiKeyAuth";
import * as ctrl from "../controllers/zapier.controller";

// ============================================================================
// ZAPIER INTEGRATION ROUTES (mounted at /v1/zapier)
// ----------------------------------------------------------------------------
// Separate surface from the generic /v1 REST API because Zapier has strict
// expectations about response shapes (flat arrays for triggers, single
// objects for actions, { id, name } for dropdowns). Keeping them separate
// means the generic API can stay clean REST and Zapier-specific quirks
// don't pollute it.
// ============================================================================

// Same rate limit as /v1 — 600/min per key.
const perKeyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  keyGenerator: (req: any) => req.apiKeyId ?? req.ip ?? "unknown",
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    code: "RATE_LIMITED",
    message: "API key rate limit exceeded (600 req/min)",
  },
});

const router = Router();
router.use(perKeyLimiter);

// ─── Auth test (Zapier connection setup) ────────────────────────────
router.get("/auth/test", authenticateApiKeyMiddleware(), ctrl.zapierAuthTest);

// ─── Triggers (Zapier polls these) ──────────────────────────────────
router.get(
  "/triggers/new_customer",
  authenticateApiKeyMiddleware(),
  ctrl.triggerNewCustomer
);
router.get(
  "/triggers/customer_updated",
  authenticateApiKeyMiddleware(),
  ctrl.triggerCustomerUpdated
);
router.get(
  "/triggers/new_deal",
  authenticateApiKeyMiddleware(),
  ctrl.triggerNewDeal
);
router.get(
  "/triggers/deal_won",
  authenticateApiKeyMiddleware(),
  ctrl.triggerDealWon
);
router.get(
  "/triggers/deal_lost",
  authenticateApiKeyMiddleware(),
  ctrl.triggerDealLost
);

// ─── Actions (Zapier calls these when a Zap fires) ──────────────────
router.post(
  "/actions/create_customer",
  authenticateApiKeyMiddleware({ requireWrite: true }),
  ctrl.actionCreateCustomer
);
router.get(
  "/actions/find_customer",
  authenticateApiKeyMiddleware(),
  ctrl.actionFindCustomer
);
router.post(
  "/actions/create_deal",
  authenticateApiKeyMiddleware({ requireWrite: true }),
  ctrl.actionCreateDeal
);
router.post(
  "/actions/update_deal_stage",
  authenticateApiKeyMiddleware({ requireWrite: true }),
  ctrl.actionUpdateDealStage
);
router.post(
  "/actions/create_task",
  authenticateApiKeyMiddleware({ requireWrite: true }),
  ctrl.actionCreateTask
);

// ─── Dynamic dropdowns (Zapier UI picker data) ──────────────────────
router.get(
  "/dropdowns/customers",
  authenticateApiKeyMiddleware(),
  ctrl.dropdownCustomers
);
router.get(
  "/dropdowns/pipeline_stages",
  authenticateApiKeyMiddleware(),
  ctrl.dropdownPipelineStages
);

export default router;
