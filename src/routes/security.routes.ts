import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import * as controller from "../controllers/security.controller";

const router = Router();
router.use(authenticateToken);

// ─── 2FA ──────────────────────────────────────────────────────────────
router.get("/2fa/status", controller.twoFactorStatus);
router.post("/2fa/begin-enroll", controller.beginEnroll);
router.post("/2fa/confirm-enroll", controller.confirmEnroll);
router.post("/2fa/disable", controller.disable2FA);
router.post("/2fa/regenerate-backup-codes", controller.regenerateBackupCodes);

// ─── Audit log ────────────────────────────────────────────────────────
router.get("/audit", controller.listAudit);
router.get("/audit/actions", controller.listAuditActions);

export default router;
