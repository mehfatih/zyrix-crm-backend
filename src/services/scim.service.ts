// ============================================================================
// SCIM 2.0 SERVICE (P7)
// ----------------------------------------------------------------------------
// Implements RFC 7644 Users endpoints for identity providers. We support
// the core attributes Okta/Azure AD/Google Workspace send by default;
// exotic extensions are accepted but ignored.
//
// Tokens follow the same pattern as compliance.service (bcrypt + prefix).
// ============================================================================

import bcrypt from "bcrypt";
import { randomBytes } from "crypto";
import { prisma } from "../config/database";
import { badRequest, notFound } from "../middleware/errorHandler";
import { hashPassword } from "../utils/password";

// ──────────────────────────────────────────────────────────────────────
// Tokens
// ──────────────────────────────────────────────────────────────────────

function newPlaintextToken(): { plaintext: string; prefix: string } {
  const raw = randomBytes(18).toString("base64url");
  const plaintext = `scim_${raw}`;
  return { plaintext, prefix: plaintext.slice(0, 12) };
}

export async function issueScimToken(
  companyId: string,
  createdBy: string,
  label: string
) {
  const trimmed = label.trim();
  if (!trimmed) throw badRequest("label is required");
  if (trimmed.length > 120)
    throw badRequest("label must be 120 chars or less");
  const { plaintext, prefix } = newPlaintextToken();
  const tokenHash = await bcrypt.hash(plaintext, 10);
  const row = await prisma.scimToken.create({
    data: { companyId, createdBy, label: trimmed, tokenHash, prefix },
    select: { id: true, label: true, prefix: true, createdAt: true },
  });
  return { ...row, plaintext };
}

export async function listScimTokens(companyId: string) {
  return prisma.scimToken.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      label: true,
      prefix: true,
      createdAt: true,
      lastUsedAt: true,
      revokedAt: true,
    },
  });
}

export async function revokeScimToken(companyId: string, id: string) {
  const row = await prisma.scimToken.findFirst({ where: { id, companyId } });
  if (!row) throw notFound("SCIM token");
  await prisma.scimToken.update({
    where: { id },
    data: { revokedAt: new Date() },
  });
  return { revoked: true };
}

export async function verifyScimToken(
  plaintext: string
): Promise<{ companyId: string; id: string } | null> {
  if (!plaintext.startsWith("scim_")) return null;
  const prefix = plaintext.slice(0, 12);
  const candidates = await prisma.scimToken.findMany({
    where: { prefix, revokedAt: null },
    select: { id: true, companyId: true, tokenHash: true },
    take: 10,
  });
  for (const c of candidates) {
    try {
      const ok = await bcrypt.compare(plaintext, c.tokenHash);
      if (ok) {
        prisma.scimToken
          .update({
            where: { id: c.id },
            data: { lastUsedAt: new Date() },
          })
          .catch(() => {});
        return { companyId: c.companyId, id: c.id };
      }
    } catch {
      // ignore
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// SCIM User mapping
// ──────────────────────────────────────────────────────────────────────
// Minimal SCIM User schema:
//   { id, schemas, userName, name: { givenName, familyName },
//     emails: [{ value, primary, type }], active, meta: { created, lastModified } }

interface ScimUserRow {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  role: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toScimUser(row: ScimUserRow, baseUrl: string) {
  const first = row.fullName.split(" ")[0] ?? row.fullName;
  const last = row.fullName.split(" ").slice(1).join(" ") || "";
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    id: row.id,
    userName: row.email,
    name: { givenName: first, familyName: last, formatted: row.fullName },
    emails: [{ value: row.email, primary: true, type: "work" }],
    phoneNumbers: row.phone
      ? [{ value: row.phone, type: "work" }]
      : undefined,
    active: row.status === "active",
    meta: {
      resourceType: "User",
      created: row.createdAt.toISOString(),
      lastModified: row.updatedAt.toISOString(),
      location: `${baseUrl.replace(/\/$/, "")}/Users/${row.id}`,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Filtering (minimal SCIM filter: `userName eq "x"`)
// ──────────────────────────────────────────────────────────────────────

export function parseUserNameFilter(filter: string | undefined): string | null {
  if (!filter) return null;
  // userName eq "x" — only operator we support
  const m = /^userName\s+eq\s+"([^"]+)"\s*$/i.exec(filter);
  return m ? m[1] : null;
}

export async function listUsers(
  companyId: string,
  opts: {
    filter?: string;
    startIndex?: number;
    count?: number;
  }
): Promise<{ totalResults: number; rows: ScimUserRow[]; startIndex: number; itemsPerPage: number }> {
  const startIndex = Math.max(1, opts.startIndex ?? 1);
  const count = Math.min(200, Math.max(1, opts.count ?? 100));
  const userName = parseUserNameFilter(opts.filter);
  const where: any = { companyId, role: { not: "super_admin" } };
  if (userName) where.email = userName.toLowerCase();

  const [total, rows] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: "asc" },
      skip: startIndex - 1,
      take: count,
      select: {
        id: true,
        email: true,
        fullName: true,
        phone: true,
        role: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);

  return {
    totalResults: total,
    rows,
    startIndex,
    itemsPerPage: rows.length,
  };
}

export async function getUser(companyId: string, id: string): Promise<ScimUserRow | null> {
  return prisma.user.findFirst({
    where: { id, companyId },
    select: {
      id: true,
      email: true,
      fullName: true,
      phone: true,
      role: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

// ──────────────────────────────────────────────────────────────────────
// SCIM CRUD
// ──────────────────────────────────────────────────────────────────────

export interface ScimUserCreate {
  userName: string;
  name?: { givenName?: string; familyName?: string; formatted?: string };
  emails?: Array<{ value: string; primary?: boolean; type?: string }>;
  phoneNumbers?: Array<{ value: string; type?: string }>;
  active?: boolean;
}

function pickPrimaryEmail(
  body: ScimUserCreate
): string | null {
  if (body.emails && body.emails.length > 0) {
    const primary = body.emails.find((e) => e.primary)?.value;
    return (primary ?? body.emails[0].value).toLowerCase();
  }
  if (body.userName) return body.userName.toLowerCase();
  return null;
}

function pickName(body: ScimUserCreate): string {
  if (body.name?.formatted) return body.name.formatted;
  const g = body.name?.givenName ?? "";
  const f = body.name?.familyName ?? "";
  const combined = `${g} ${f}`.trim();
  if (combined) return combined;
  return body.userName.split("@")[0];
}

export async function createUser(
  companyId: string,
  body: ScimUserCreate
): Promise<ScimUserRow> {
  const email = pickPrimaryEmail(body);
  if (!email) throw badRequest("email is required");
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (existing) throw badRequest(`A user with email ${email} already exists`);

  // Provisioned accounts get a random password hash; the IdP owns auth
  // via SSO (Google / Azure AD). A reset flow still works via /forgot.
  const randomPass = randomBytes(24).toString("base64url");
  const passwordHash = await hashPassword(randomPass);

  const row = await prisma.user.create({
    data: {
      companyId,
      email,
      fullName: pickName(body),
      phone: body.phoneNumbers?.[0]?.value ?? null,
      passwordHash,
      role: "member",
      status: body.active === false ? "disabled" : "active",
      emailVerified: false,
    },
    select: {
      id: true,
      email: true,
      fullName: true,
      phone: true,
      role: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return row;
}

export interface ScimUserReplace extends ScimUserCreate {}

export async function replaceUser(
  companyId: string,
  id: string,
  body: ScimUserReplace
): Promise<ScimUserRow | null> {
  const existing = await prisma.user.findFirst({
    where: { id, companyId },
    select: { id: true, role: true },
  });
  if (!existing) return null;
  if (existing.role === "super_admin") {
    throw badRequest("Cannot modify super_admin via SCIM");
  }

  const email = pickPrimaryEmail(body);
  const data: Record<string, unknown> = {
    fullName: pickName(body),
    phone: body.phoneNumbers?.[0]?.value ?? null,
    status: body.active === false ? "disabled" : "active",
  };
  if (email) data.email = email;

  const row = await prisma.user.update({
    where: { id },
    data,
    select: {
      id: true,
      email: true,
      fullName: true,
      phone: true,
      role: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return row;
}

export interface ScimPatchOp {
  op: "add" | "remove" | "replace" | string;
  path?: string;
  value?: unknown;
}

export async function patchUser(
  companyId: string,
  id: string,
  operations: ScimPatchOp[]
): Promise<ScimUserRow | null> {
  const existing = await prisma.user.findFirst({
    where: { id, companyId },
    select: { id: true, role: true },
  });
  if (!existing) return null;
  if (existing.role === "super_admin") {
    throw badRequest("Cannot modify super_admin via SCIM");
  }

  const data: Record<string, unknown> = {};
  for (const op of operations) {
    const action = (op.op ?? "").toLowerCase();
    if (action !== "replace" && action !== "add" && action !== "remove") continue;
    const path = (op.path ?? "").toLowerCase();

    // active flag — handle both path form and bulk-replace form
    if (path === "active" || (!op.path && op.value && typeof op.value === "object" && "active" in (op.value as any))) {
      const next = op.path ? op.value : (op.value as any).active;
      data.status = next === false ? "disabled" : "active";
    }
    if (path === "name.givenname" || path === "name.familyname") {
      // For simplicity we ignore partial name patches; IdPs sending PATCH
      // usually send `{ op: 'replace', value: { name: {...} } }` which is
      // handled by the bulk-replace branch below.
    }
    if (!op.path && op.value && typeof op.value === "object") {
      const v = op.value as any;
      if (v.name) {
        data.fullName =
          v.name.formatted ??
          `${v.name.givenName ?? ""} ${v.name.familyName ?? ""}`.trim();
      }
      if (Array.isArray(v.emails)) {
        const primary = v.emails.find((e: any) => e.primary)?.value;
        if (primary) data.email = String(primary).toLowerCase();
      }
      if (Array.isArray(v.phoneNumbers) && v.phoneNumbers[0]?.value) {
        data.phone = v.phoneNumbers[0].value;
      }
      if (typeof v.active === "boolean") {
        data.status = v.active ? "active" : "disabled";
      }
    }
  }

  if (Object.keys(data).length === 0) {
    // No-op patch — return current state
    return prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        fullName: true,
        phone: true,
        role: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  return prisma.user.update({
    where: { id },
    data,
    select: {
      id: true,
      email: true,
      fullName: true,
      phone: true,
      role: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function softDeleteUser(
  companyId: string,
  id: string
): Promise<{ deleted: boolean }> {
  const existing = await prisma.user.findFirst({
    where: { id, companyId },
    select: { id: true, role: true },
  });
  if (!existing) return { deleted: false };
  if (existing.role === "super_admin") {
    throw badRequest("Cannot deprovision super_admin via SCIM");
  }
  await prisma.user.update({
    where: { id },
    data: {
      status: "disabled",
      disabledAt: new Date(),
      disabledReason: "scim:deprovisioned",
    },
  });
  return { deleted: true };
}
