import { Router } from "express";
import multer from "multer";
import { authenticateToken } from "../middleware/auth";
import * as ctrl from "../controllers/import.controller";

// ============================================================================
// CONTACT IMPORT ROUTES — mounted at /api/import
// ----------------------------------------------------------------------------
// File upload uses multer in-memory storage (max 5 MB). All routes are
// session-authed. The Google-Sheet import source lives under
// /api/integrations/google/import/sheet (same preview/commit shape).
// ============================================================================

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

const router = Router();
router.use(authenticateToken);

router.post("/contacts/preview", upload.single("file"), ctrl.previewContacts);
router.post("/contacts/commit", ctrl.commitContacts);

export default router;
