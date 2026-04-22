import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import { requirePermission } from "../middleware/requirePermission";
import { gateFeature } from "../middleware/feature-gate";
import * as ctrl from "../controllers/roles.controller";

const router = Router();

// Permission catalog — any authenticated user can read it (the UI needs
// the list to render, even for users who can't actually edit roles).
router.get("/permissions", authenticateToken, ctrl.catalog);

// Caller's own effective permissions — hydrates frontend hasPermission().
// Not gated by `rbac`: the UI still needs the built-in role permissions
// for gating even when custom-role RBAC is disabled for the plan.
router.get("/permissions/me", authenticateToken, ctrl.mine);

// Custom-role CRUD and assignment lives behind the `rbac` feature.
// Reading the team still works without rbac (the /users list powers
// basic settings UI even on free/starter plans).
const rbac = gateFeature("rbac");

router.get(
  "/roles",
  authenticateToken,
  rbac,
  requirePermission("settings:users"),
  ctrl.list
);
router.get(
  "/roles/:id",
  authenticateToken,
  rbac,
  requirePermission("settings:users"),
  ctrl.get
);
router.post(
  "/roles",
  authenticateToken,
  rbac,
  requirePermission("settings:roles"),
  ctrl.create
);
router.patch(
  "/roles/:id",
  authenticateToken,
  rbac,
  requirePermission("settings:roles"),
  ctrl.update
);
router.delete(
  "/roles/:id",
  authenticateToken,
  rbac,
  requirePermission("settings:roles"),
  ctrl.remove
);

// List team members in caller's company. Not rbac-gated so team
// visibility works across all plans.
router.get(
  "/users",
  authenticateToken,
  requirePermission("settings:users"),
  ctrl.listUsers
);

// Assigning a user to a CUSTOM role requires the rbac feature; built-in
// role changes don't (caller still needs settings:users permission).
router.patch(
  "/users/:id/role",
  authenticateToken,
  requirePermission("settings:users"),
  ctrl.assignRole
);

export default router;
