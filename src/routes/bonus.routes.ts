import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import { gateFeature } from "../middleware/feature-gate";
import * as ctrl from "../controllers/bonus.controller";

const router = Router();

// Public signing endpoint — no auth (token in URL is the authz). Still
// gated so merchants on plans without e-signature can't harvest it.
router.post("/signatures/complete", gateFeature("e_signature"), ctrl.completeSignature);

router.use(authenticateToken);

// B1 — duplicate detection
router.post(
  "/customers/detect-duplicates",
  gateFeature("duplicate_detection"),
  ctrl.detectDuplicates
);
// B2 — conversation intelligence
router.post(
  "/conversations/classify",
  gateFeature("conversation_intel"),
  ctrl.classifyConversation
);
// B3 — lead scoring
router.post(
  "/lead-scores/recompute",
  gateFeature("lead_scoring"),
  ctrl.recomputeLeadScores
);
// B4 — territories
router.get("/territories", gateFeature("territories"), ctrl.listTerritories);
router.put("/territories", gateFeature("territories"), ctrl.upsertTerritory);
router.post("/territories/assign", gateFeature("territories"), ctrl.assignTerritories);
// B5 — quota / forecast
router.get("/quotas", gateFeature("quota_forecast"), ctrl.listQuotas);
router.put("/quotas", gateFeature("quota_forecast"), ctrl.upsertQuota);
router.get(
  "/quotas/attainment",
  gateFeature("quota_forecast"),
  ctrl.quotaAttainment
);
// B6 — meetings
router.get("/meetings", gateFeature("meeting_intel"), ctrl.listMeetings);
router.post("/meetings", gateFeature("meeting_intel"), ctrl.ingestMeeting);
// B7 — e-signature
router.post("/signatures/request", gateFeature("e_signature"), ctrl.requestSignature);
router.get("/signatures/:contractId", gateFeature("e_signature"), ctrl.listSignatures);
// B8 — health score
router.post(
  "/health-scores/recompute",
  gateFeature("health_score"),
  ctrl.recomputeHealthScores
);
// B10 — Slack / MS Teams integration
router.get("/slack-webhook", gateFeature("slack_teams"), ctrl.getSlack);
router.put("/slack-webhook", gateFeature("slack_teams"), ctrl.upsertSlack);
router.delete("/slack-webhook", gateFeature("slack_teams"), ctrl.removeSlack);

export default router;
