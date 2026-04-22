// ============================================================================
// ROLES CONTROLLER (P1)
// ----------------------------------------------------------------------------
// Exposes the permission catalog and the CRUD surface for per-company roles.
// Also handles PATCH /api/users/:id/role (merchant-scope user↔role wiring).
// ============================================================================

import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import {
  PERMISSION_CATALOG,
  PERMISSIONS,
} from "../constants/permissions";
import {
  assignUserRole,
  createRole,
  deleteRole,
  getRole,
  listRoles,
  updateRole,
} from "../services/roles.service";
import { getEffectivePermissions } from "../services/rbac.service";
import { recordAudit, extractRequestMeta } from "../utils/audit";

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId, role: r.user.role };
}

// ──────────────────────────────────────────────────────────────────────
// GET /api/permissions — catalog (any authenticated user)
// ──────────────────────────────────────────────────────────────────────

export function catalog(_req: Request, res: Response) {
  res.status(200).json({
    success: true,
    data: {
      permissions: PERMISSIONS,
      catalog: PERMISSION_CATALOG,
    },
  });
}

// ──────────────────────────────────────────────────────────────────────
// GET /api/permissions/me — caller's resolved permission set
// ──────────────────────────────────────────────────────────────────────
// Used by the frontend AuthProvider to hydrate hasPermission() at login
// and on refresh. Returns an empty array if the user is missing — the
// frontend treats that as "no permissions" and hides everything, which
// is the right behavior for a deleted account.
// ──────────────────────────────────────────────────────────────────────

export async function mine(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, role } = auth(req);
    const permissions = await getEffectivePermissions(userId, role);
    res.status(200).json({ success: true, data: { permissions } });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// GET /api/roles — list this company's roles
// ──────────────────────────────────────────────────────────────────────

export async function list(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await listRoles(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// GET /api/roles/:id
// ──────────────────────────────────────────────────────────────────────

export async function get(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await getRole(req.params.id as string, companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// POST /api/roles — create a custom role
// ──────────────────────────────────────────────────────────────────────

const createSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional().nullable(),
  permissions: z.array(z.string()),
});

export async function create(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const dto = createSchema.parse(req.body) as any;
    const data = await createRole(companyId, dto);
    await recordAudit({
      userId,
      companyId,
      action: "role.create",
      entityType: "role",
      entityId: data.id,
      metadata: { name: data.name, permissionCount: data.permissions.length },
      ...extractRequestMeta(req),
    });
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// PATCH /api/roles/:id
// ──────────────────────────────────────────────────────────────────────

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  permissions: z.array(z.string()).optional(),
});

export async function update(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const dto = updateSchema.parse(req.body) as any;
    const id = req.params.id as string;
    const data = await updateRole(id, companyId, dto);
    await recordAudit({
      userId,
      companyId,
      action: "role.update",
      entityType: "role",
      entityId: id,
      metadata: { fields: Object.keys(dto) },
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// DELETE /api/roles/:id
// ──────────────────────────────────────────────────────────────────────

export async function remove(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const id = req.params.id as string;
    const data = await deleteRole(id, companyId);
    await recordAudit({
      userId,
      companyId,
      action: "role.delete",
      entityType: "role",
      entityId: id,
      metadata: { detachedUsers: data.detachedUsers },
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// PATCH /api/users/:id/role — assign a role (built-in and/or custom)
// ──────────────────────────────────────────────────────────────────────

const assignSchema = z.object({
  role: z.string().optional(),
  customRoleId: z.string().nullable().optional(),
});

export async function assignRole(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId: actorId, companyId } = auth(req);
    const dto = assignSchema.parse(req.body) as any;
    const targetUserId = req.params.id as string;
    const data = await assignUserRole(targetUserId, companyId, dto);
    await recordAudit({
      userId: actorId,
      companyId,
      action: "user.role_assigned",
      entityType: "user",
      entityId: targetUserId,
      metadata: {
        role: data.role,
        customRoleId: data.customRoleId,
      },
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
