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

  const rows = (await prisma.$queryRawUnsafe(
    `SELECT u."role", u."customRoleId", r."permissions"
       FROM "users" u
       LEFT JOIN "roles" r ON r."id" = u."customRoleId"
      WHERE u."id" = $1
      LIMIT 1`,
    userId
  )) as Array<{ role: string; customRoleId: string | null; permissions: unknown }>;

  if (rows.length === 0) return [];
  const row = rows[0];

  if (row.customRoleId && row.permissions !== null && row.permissions !== undefined) {
    return parsePermissionsJson(row.permissions);
  }

  return getBuiltInRolePermissions(row.role);
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
