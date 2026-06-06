import { Router } from "express";
import * as profile from "../controllers/ai-studio.controller";
import { authenticateToken, requireRole } from "../middleware/auth";
import { requireFeature } from "../middleware/entitlement-gate";

// ============================================================================
// AI STUDIO ROUTES — /api/ai-studio/* (Sprint 13)
// Profile read = any authenticated user (so AI features can be previewed);
// mutate = owner/admin/manager. Saved reports are added in Phase C.
// ============================================================================
const router = Router();
router.use(authenticateToken);
router.use(requireFeature("ai_studio")); // Sprint 16B (flag-gated)

const canManage = requireRole("owner", "admin", "manager");

// Company AI profile
router.get("/profile", profile.get);
router.put("/profile", canManage, profile.save);
router.delete("/profile", canManage, profile.remove);
router.post("/profile/preview", profile.preview);

// Saved AI reports
router.get("/reports", profile.listReportsH);
router.post("/reports", canManage, profile.createReportH);
router.patch("/reports/:id", canManage, profile.updateReportH);
router.delete("/reports/:id", canManage, profile.deleteReportH);
router.post("/reports/:id/run", canManage, profile.runReportH);

export default router;
