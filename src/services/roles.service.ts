// ============================================================================
// ROLES — CRUD + system role seeding (P1)
// ----------------------------------------------------------------------------
// All queries are scoped by companyId — a role belongs to exactly one
// company and is invisible to any other company's users.
//
// System roles (isSystem=true) are the four built-in defaults and cannot
// be edited or deleted via the public API. They exist as real rows so
// the admin UI can show them in the same list as custom roles and users
// can be assigned to them via customRoleId if a merchant wants to "pin"
// someone explicitly to a default set — but most users leave customRoleId
// null and fall back to User.role string + DEFAULT_ROLE_PERMISSIONS.
// ============================================================================

import { prisma } from "../config/database";
import { badRequest, conflict, forbidden, notFound } from "../middleware/errorHandler";
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSIONS,
  isValidPermission,
  type BuiltInRole,
  type Permission,
} from "../constants/permissions";

const ALL: readonly Permission[] = PERMISSIONS;

// ──────────────────────────────────────────────────────────────────────
// Shared helpers
// ──────────────────────────────────────────────────────────────────────

function sanitizePermissions(raw: unknown): Permission[] {
  if (!Array.isArray(raw)) {
    throw badRequest("permissions must be an array of strings");
  }
  const out: Permission[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") {
      throw badRequest("permissions must be an array of strings");
    }
    if (!isValidPermission(item)) {
      throw badRequest(`Unknown permission: ${item}`);
    }
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

function shapeRole(row: {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: unknown;
  createdAt: Date;
  updatedAt: Date;
}) {
  // Filter against the current catalog on read, so stale keys never leak
  // into the API response.
  const perms = Array.isArray(row.permissions)
    ? row.permissions.filter(
        (p): p is Permission =>
          typeof p === "string" && (ALL as readonly string[]).includes(p)
      )
    : [];
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    description: row.description,
    isSystem: row.isSystem,
    permissions: perms,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Read
// ──────────────────────────────────────────────────────────────────────

export async function listRoles(companyId: string) {
  const rows = await prisma.role.findMany({
    where: { companyId },
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
  });
  return rows.map(shapeRole);
}

export async function getRole(id: string, companyId: string) {
  const row = await prisma.role.findFirst({
    where: { id, companyId },
  });
  if (!row) throw notFound("Role");
  return shapeRole(row);
}

// ──────────────────────────────────────────────────────────────────────
// Write
// ──────────────────────────────────────────────────────────────────────

export interface CreateRoleInput {
  name: string;
  description?: string | null;
  permissions: unknown;
}

export async function createRole(companyId: string, input: CreateRoleInput) {
  const name = input.name?.trim();
  if (!name) throw badRequest("name is required");
  if (name.length > 100) throw badRequest("name must be 100 chars or less");
  const perms = sanitizePermissions(input.permissions);

  const existing = await prisma.role.findUnique({
    where: { companyId_name: { companyId, name } },
  });
  if (existing) throw conflict(`A role named "${name}" already exists`);

  const created = await prisma.role.create({
    data: {
      companyId,
      name,
      description: input.description?.trim() || null,
      isSystem: false,
      permissions: perms as unknown as any,
    },
  });
  return shapeRole(created);
}

export interface UpdateRoleInput {
  name?: string;
  description?: string | null;
  permissions?: unknown;
}

export async function updateRole(
  id: string,
  companyId: string,
  input: UpdateRoleInput
) {
  const existing = await prisma.role.findFirst({ where: { id, companyId } });
  if (!existing) throw notFound("Role");
  if (existing.isSystem) {
    throw forbidden("System roles cannot be edited");
  }

  const data: {
    name?: string;
    description?: string | null;
    permissions?: unknown;
  } = {};

  if (input.name !== undefined) {
    const next = input.name.trim();
    if (!next) throw badRequest("name cannot be empty");
    if (next.length > 100) throw badRequest("name must be 100 chars or less");
    if (next !== existing.name) {
      const clash = await prisma.role.findUnique({
        where: { companyId_name: { companyId, name: next } },
      });
      if (clash) throw conflict(`A role named "${next}" already exists`);
      data.name = next;
    }
  }
  if (input.description !== undefined) {
    data.description = input.description?.trim() || null;
  }
  if (input.permissions !== undefined) {
    data.permissions = sanitizePermissions(input.permissions);
  }

  const updated = await prisma.role.update({
    where: { id },
    data: data as any,
  });
  return shapeRole(updated);
}

export async function deleteRole(id: string, companyId: string) {
  const existing = await prisma.role.findFirst({ where: { id, companyId } });
  if (!existing) throw notFound("Role");
  if (existing.isSystem) {
    throw forbidden("System roles cannot be deleted");
  }

  // Detach any users currently assigned — they fall back to built-in role.
  // (The FK is ON DELETE SET NULL, so Postgres would do this anyway, but
  // being explicit avoids any race where the count we return is wrong.)
  const { count } = await prisma.user.updateMany({
    where: { customRoleId: id, companyId },
    data: { customRoleId: null },
  });

  await prisma.role.delete({ where: { id } });
  return { deleted: true, detachedUsers: count };
}

// ──────────────────────────────────────────────────────────────────────
// Seed system roles
// ──────────────────────────────────────────────────────────────────────
// Idempotent — safe to call on every signup and from the migration seed.
// Creates any of the four system roles that don't already exist for the
// given company.
// ──────────────────────────────────────────────────────────────────────

const SYSTEM_ROLE_META: Record<
  BuiltInRole,
  { description: string }
> = {
  owner: { description: "Full control of the account." },
  admin: { description: "Manage the business but not billing or roles." },
  manager: {
    description: "Lead the team — read and write business records, view all reports.",
  },
  member: { description: "Day-to-day team member with basic access." },
};

export async function seedSystemRoles(companyId: string) {
  const existing = await prisma.role.findMany({
    where: { companyId, isSystem: true },
    select: { name: true },
  });
  const existingNames = new Set(existing.map((r) => r.name));

  const roles: BuiltInRole[] = ["owner", "admin", "manager", "member"];
  for (const name of roles) {
    if (existingNames.has(name)) continue;
    await prisma.role.create({
      data: {
        companyId,
        name,
        description: SYSTEM_ROLE_META[name].description,
        isSystem: true,
        permissions: DEFAULT_ROLE_PERMISSIONS[name] as unknown as any,
      },
    });
  }
}

// ──────────────────────────────────────────────────────────────────────
// User ↔ role assignment
// ──────────────────────────────────────────────────────────────────────

export interface AssignUserRoleInput {
  role?: string; // built-in role string — null/undefined leaves it alone
  customRoleId?: string | null; // explicit null = clear the custom role
}

const BUILT_IN: BuiltInRole[] = ["owner", "admin", "manager", "member"];

export async function assignUserRole(
  userId: string,
  companyId: string,
  input: AssignUserRoleInput
) {
  const user = await prisma.user.findFirst({
    where: { id: userId, companyId },
  });
  if (!user) throw notFound("User");
  if (user.role === "super_admin") {
    throw forbidden("super_admin role is managed by the platform owner");
  }

  const data: { role?: string; customRoleId?: string | null } = {};

  if (input.role !== undefined) {
    if (!BUILT_IN.includes(input.role as BuiltInRole)) {
      throw badRequest(
        `Invalid role. Must be one of: ${BUILT_IN.join(", ")}`
      );
    }
    data.role = input.role;
  }

  if (input.customRoleId !== undefined) {
    if (input.customRoleId === null) {
      data.customRoleId = null;
    } else {
      const role = await prisma.role.findFirst({
        where: { id: input.customRoleId, companyId },
      });
      if (!role) throw notFound("Role");
      data.customRoleId = input.customRoleId;
    }
  }

  if (Object.keys(data).length === 0) {
    throw badRequest("Nothing to update");
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data,
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
      customRoleId: true,
    },
  });
  return updated;
}
