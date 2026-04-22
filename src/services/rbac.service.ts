// ============================================================================
// RBAC — Effective permissions for a user (P1)
// ----------------------------------------------------------------------------
// A user's effective permission set is resolved in this order:
//
//   1. super_admin role (platform-owner JWT claim) → every permission
//   2. User.customRoleId is set  → load Role.permissions from DB
//   3. Otherwise                 → DEFAULT_ROLE_PERMISSIONS[User.role]
//
// Used by:
//   • requirePermission() middleware
//   • /api/me to return permissions the frontend consumes for hasPermission()
// ============================================================================

import { prisma } from "../config/database";
import {
  DEFAULT_ROLE_PERMISSIONS,
  getBuiltInRolePermissions,
  PERMISSIONS,
  type BuiltInRole,
  type Permission,
} from "../constants/permissions";

const ALL: readonly Permission[] = PERMISSIONS;

function parsePermissionsJson(raw: unknown): Permission[] {
  if (!Array.isArray(raw)) return [];
  const out: Permission[] = [];
  for (const item of raw) {
    if (typeof item === "string" && (ALL as readonly string[]).includes(item)) {
      out.push(item as Permission);
    }
  }
  return out;
}

/**
 * Resolve the full, canonical permission set for a user. Returns an empty
 * array if the user is not found.
 *
 * super_admin callers get ALL permissions — that role lives outside the
 * per-company role model and always has platform-wide access.
 */
export async function getEffectivePermissions(
  userId: string,
  roleHint?: string
): Promise<Permission[]> {
  if (roleHint === "super_admin") return [...ALL];

  // Step 1: read the user's role string + customRoleId from the users
  // table. Always works regardless of whether the roles table exists.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, customRoleId: true },
  });
  if (!user) return [];

  // Step 2 (optional): if customRoleId is set, fetch that role's
  // permissions. Wrapped in try/catch so a missing `roles` table (pre-
  // SQL-apply) gracefully degrades to the built-in role fallback
  // rather than throwing a 500.
  if (user.customRoleId) {
    try {
      const role = await prisma.role.findUnique({
        where: { id: user.customRoleId },
        select: { permissions: true },
      });
      if (role) return parsePermissionsJson(role.permissions);
    } catch (err) {
      console.warn(
        "[rbac] roles table lookup failed; falling back to built-in role map:",
        (err as Error).message
      );
    }
  }

  return getBuiltInRolePermissions(user.role);
}

export async function userHasPermission(
  userId: string,
  permission: Permission,
  roleHint?: string
): Promise<boolean> {
  if (roleHint === "super_admin") return true;
  const perms = await getEffectivePermissions(userId, roleHint);
  return perms.includes(permission);
}

/**
 * Bulk check — returns true only if the user has EVERY permission.
 * Useful for endpoints that require a combination (e.g. read + write).
 */
export async function userHasAllPermissions(
  userId: string,
  required: Permission[],
  roleHint?: string
): Promise<boolean> {
  if (roleHint === "super_admin") return true;
  const perms = new Set(await getEffectivePermissions(userId, roleHint));
  return required.every((p) => perms.has(p));
}

export { DEFAULT_ROLE_PERMISSIONS, type BuiltInRole };
