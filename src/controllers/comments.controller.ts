import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import {
  createComment,
  listComments,
  getCommentById,
  updateComment,
  deleteComment,
} from "../services/comments.service";

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return {
    userId: r.user.userId,
    companyId: r.user.companyId,
    role: r.user.role,
  };
}

// ──────────────────────────────────────────────────────────────────────
// LIST comments for an entity
// /api/comments?entityType=deal&entityId=...
// ──────────────────────────────────────────────────────────────────────

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const entityType = req.query.entityType as string;
    const entityId = req.query.entityId as string;
    if (!entityType || !entityId) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_QUERY",
          message: "entityType + entityId query params required",
        },
      });
    }
    const data = await listComments(
      companyId,
      entityType as any,
      entityId
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// CREATE a comment
// ──────────────────────────────────────────────────────────────────────

const createSchema = z.object({
  entityType: z.enum(["customer", "deal", "activity"]),
  entityId: z.string().uuid(),
  body: z.string().min(1).max(10000),
  parentId: z.string().uuid().optional(),
});

export async function create(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const dto = createSchema.parse(req.body);
    const data = await createComment(companyId, userId, dto as any);
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// GET one comment by id
// ──────────────────────────────────────────────────────────────────────

export async function detail(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await getCommentById(companyId, req.params.id as string);
    if (!data) {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Comment not found" },
      });
    }
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// UPDATE — author only
// ──────────────────────────────────────────────────────────────────────

const updateSchema = z.object({
  body: z.string().min(1).max(10000),
});

export async function update(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const { body } = updateSchema.parse(req.body);
    const data = await updateComment(
      companyId,
      userId,
      req.params.id as string,
      body
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// DELETE — author or owner/admin
// ──────────────────────────────────────────────────────────────────────

export async function remove(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId, role } = auth(req);
    const data = await deleteComment(
      companyId,
      userId,
      req.params.id as string,
      role
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
