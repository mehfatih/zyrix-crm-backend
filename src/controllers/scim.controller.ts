// ============================================================================
// SCIM 2.0 CONTROLLER (P7) — Users endpoints
// ----------------------------------------------------------------------------
// RFC 7644 / 7643 conformance for the Users resource. Response bodies are
// wrapped in the SCIM schema envelope so Okta / Azure AD / Google /
// JumpCloud validators accept them without squinting.
// ============================================================================

import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types";
import * as ScimSvc from "../services/scim.service";

function scimError(
  res: Response,
  status: number,
  detail: string,
  scimType?: string
) {
  res.status(status).json({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
    detail,
    status: String(status),
    ...(scimType ? { scimType } : {}),
  });
}

function baseUrl(req: Request) {
  const host = req.get("host") || "api.crm.zyrix.co";
  const proto = req.protocol === "https" ? "https" : req.get("x-forwarded-proto") || "https";
  return `${proto}://${host}/scim/v2`;
}

// ──────────────────────────────────────────────────────────────────────
// GET /Users
// ──────────────────────────────────────────────────────────────────────

export async function listUsers(req: Request, res: Response) {
  const r = req as AuthenticatedRequest;
  const { totalResults, rows, startIndex, itemsPerPage } = await ScimSvc.listUsers(
    r.user.companyId,
    {
      filter: typeof req.query.filter === "string" ? req.query.filter : undefined,
      startIndex: Number(req.query.startIndex) || undefined,
      count: Number(req.query.count) || undefined,
    }
  );
  const url = baseUrl(req);
  res.status(200).json({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults,
    Resources: rows.map((r) => ScimSvc.toScimUser(r, url)),
    startIndex,
    itemsPerPage,
  });
}

// ──────────────────────────────────────────────────────────────────────
// GET /Users/:id
// ──────────────────────────────────────────────────────────────────────

export async function getUser(req: Request, res: Response) {
  const r = req as AuthenticatedRequest;
  const row = await ScimSvc.getUser(r.user.companyId, req.params.id as string);
  if (!row) return scimError(res, 404, "User not found");
  res.status(200).json(ScimSvc.toScimUser(row, baseUrl(req)));
}

// ──────────────────────────────────────────────────────────────────────
// POST /Users
// ──────────────────────────────────────────────────────────────────────

export async function createUser(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const r = req as AuthenticatedRequest;
    const row = await ScimSvc.createUser(r.user.companyId, req.body || {});
    res.status(201).json(ScimSvc.toScimUser(row, baseUrl(req)));
  } catch (err: any) {
    if (err?.statusCode === 400) {
      return scimError(res, 400, err.message, "invalidValue");
    }
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// PUT /Users/:id — full replace
// ──────────────────────────────────────────────────────────────────────

export async function replaceUser(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const r = req as AuthenticatedRequest;
    const row = await ScimSvc.replaceUser(
      r.user.companyId,
      req.params.id as string,
      req.body || {}
    );
    if (!row) return scimError(res, 404, "User not found");
    res.status(200).json(ScimSvc.toScimUser(row, baseUrl(req)));
  } catch (err: any) {
    if (err?.statusCode === 400) {
      return scimError(res, 400, err.message, "invalidValue");
    }
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// PATCH /Users/:id — partial per RFC 7644 §3.5.2
// ──────────────────────────────────────────────────────────────────────

export async function patchUser(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const r = req as AuthenticatedRequest;
    const body = req.body || {};
    const ops: ScimSvc.ScimPatchOp[] = Array.isArray(body.Operations)
      ? body.Operations
      : [];
    const row = await ScimSvc.patchUser(
      r.user.companyId,
      req.params.id as string,
      ops
    );
    if (!row) return scimError(res, 404, "User not found");
    res.status(200).json(ScimSvc.toScimUser(row, baseUrl(req)));
  } catch (err: any) {
    if (err?.statusCode === 400) {
      return scimError(res, 400, err.message, "invalidValue");
    }
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// DELETE /Users/:id — soft delete / deactivate
// ──────────────────────────────────────────────────────────────────────

export async function deleteUser(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const r = req as AuthenticatedRequest;
    const { deleted } = await ScimSvc.softDeleteUser(
      r.user.companyId,
      req.params.id as string
    );
    if (!deleted) return scimError(res, 404, "User not found");
    res.status(204).send();
  } catch (err: any) {
    if (err?.statusCode === 400) {
      return scimError(res, 400, err.message, "invalidValue");
    }
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// GET /Groups — minimal empty list so IdPs don't error out
// ──────────────────────────────────────────────────────────────────────

export async function listGroups(_req: Request, res: Response) {
  res.status(200).json({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults: 0,
    Resources: [],
    startIndex: 1,
    itemsPerPage: 0,
  });
}

// ──────────────────────────────────────────────────────────────────────
// GET /ServiceProviderConfig
// ──────────────────────────────────────────────────────────────────────

export async function providerConfig(_req: Request, res: Response) {
  res.status(200).json({
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    documentationUri: "https://crm.zyrix.co/docs/scim",
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        name: "OAuth Bearer Token",
        description: "Authentication via the scim_* bearer token",
        specUri: "http://www.rfc-editor.org/info/rfc6750",
        type: "oauthbearertoken",
        primary: true,
      },
    ],
  });
}
