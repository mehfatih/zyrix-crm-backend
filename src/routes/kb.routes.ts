import { Router } from "express";
import * as controller from "../controllers/kb.controller";
import { authenticateToken, requireRole } from "../middleware/auth";
import { requireFeature } from "../middleware/entitlement-gate";

// ============================================================================
// KNOWLEDGE BASE ROUTES — /api/knowledge-base/* (Sprint 19, authenticated)
// Gated by the `knowledge_base` entitlement (flag-controlled).
// Read = any authenticated user; build/mutate = owner/admin/manager.
// ============================================================================
const router = Router();
router.use(authenticateToken);
router.use(requireFeature("knowledge_base"));

const canBuild = requireRole("owner", "admin", "manager");

// Categories
router.get("/categories", controller.listCategories);
router.post("/categories", canBuild, controller.createCategory);
router.patch("/categories/:id", canBuild, controller.updateCategory);
router.delete("/categories/:id", canBuild, controller.deleteCategory);

// AI assist (static path before /:id)
router.post("/translate", canBuild, controller.translate);

// Articles
router.get("/", controller.listArticles);
router.post("/", canBuild, controller.createArticle);
router.get("/:id", controller.getArticle);
router.patch("/:id", canBuild, controller.updateArticle);
router.delete("/:id", canBuild, controller.deleteArticle);

export default router;
