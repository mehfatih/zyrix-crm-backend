import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import * as ctrl from "../controllers/bonus.controller";

const router = Router();

// Public signing endpoint — no auth (token in URL is the authz)
router.post("/signatures/complete", ctrl.completeSignature);

router.use(authenticateToken);

// B1
router.post("/customers/detect-duplicates", ctrl.detectDuplicates);
// B2
router.post("/conversations/classify", ctrl.classifyConversation);
// B3
router.post("/lead-scores/recompute", ctrl.recomputeLeadScores);
// B4
router.get("/territories", ctrl.listTerritories);
router.put("/territories", ctrl.upsertTerritory);
router.post("/territories/assign", ctrl.assignTerritories);
// B5
router.get("/quotas", ctrl.listQuotas);
router.put("/quotas", ctrl.upsertQuota);
router.get("/quotas/attainment", ctrl.quotaAttainment);
// B6
router.get("/meetings", ctrl.listMeetings);
router.post("/meetings", ctrl.ingestMeeting);
// B7
router.post("/signatures/request", ctrl.requestSignature);
router.get("/signatures/:contractId", ctrl.listSignatures);
// B8
router.post("/health-scores/recompute", ctrl.recomputeHealthScores);
// B10
router.get("/slack-webhook", ctrl.getSlack);
router.put("/slack-webhook", ctrl.upsertSlack);
router.delete("/slack-webhook", ctrl.removeSlack);

export default router;
