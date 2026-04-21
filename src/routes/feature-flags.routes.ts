import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import * as ctrl from "../controllers/feature-flags.controller";

const router = Router();

// Public catalog — describes what features exist. Consumed by the
// admin UI to render the toggle list.
router.get("/catalog", ctrl.catalog);

// Current company's resolved flag map — any authenticated user of
// the company can read this (the frontend uses it to filter UI).
router.get("/", authenticateToken, ctrl.currentCompanyFlags);

export default router;
