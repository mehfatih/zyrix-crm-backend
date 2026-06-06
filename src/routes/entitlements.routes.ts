import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import * as ctrl from "../controllers/entitlements.controller";

const router = Router();

// Authenticated company's resolved entitlement map (features + limits + plan).
router.get("/me", authenticateToken, ctrl.me);

export default router;
