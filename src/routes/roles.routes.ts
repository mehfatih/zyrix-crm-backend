import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import { requirePermission } from "../middleware/requirePermission";
import * as ctrl from "../controllers/roles.controller";

const router = Router();

// Permission catalog — any authenticated user can read it (the UI needs
// the list to render, even for users who can't actually edit roles).
router.get("/permissions", authenticateToken, ctrl.catalog);

// Role CRUD — scoped to the caller's company.
router.get(
  "/roles",
  authenticateToken,
  requirePermission("settings:users"),
  ctrl.list
);
router.get(
  "/roles/:id",
  authenticateToken,
  requirePermission("settings:users"),
  ctrl.get
);
router.post(
  "/roles",
  authenticateToken,
  requirePermission("settings:roles"),
  ctrl.create
);
router.patch(
  "/roles/:id",
  authenticateToken,
  requirePermission("settings:roles"),
  ctrl.update
);
router.delete(
  "/roles/:id",
  authenticateToken,
  requirePermission("settings:roles"),
  ctrl.remove
);

// Assign a user to a role (built-in via role string, custom via customRoleId).
router.patch(
  "/users/:id/role",
  authenticateToken,
  requirePermission("settings:users"),
  ctrl.assignRole
);

export default router;
