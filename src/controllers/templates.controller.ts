import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import {
  listTemplates,
  getTemplate,
  applyTemplate,
  listCompanyApplications,
  revertApplication,
} from "../services/templates.service";
import { recordAudit, extractRequestMeta } from "../utils/audit";

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return {
    userId: r.user.userId,
    companyId: r.user.companyId,
    role: r.user.role,
  };
}

const listQuerySchema = z.object({
  industry: z.string().optional(),
  region: z.string().optional(),
});

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const q = listQuerySchema.parse(req.query);
    const data = await listTemplates(q);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function detail(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const slug = req.params.slug as string;
    const data = await getTemplate(slug);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function apply(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, companyId, role } = auth(req);
    // Only owners and admins can apply — template apply creates
    // pipeline stages, tags, seed data. Regular members can't.
    if (role !== "owner" && role !== "admin") {
      return res.status(403).json({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: "Only owners and admins can apply templates.",
        },
      });
    }
    const slug = req.params.slug as string;
    const data = await applyTemplate(companyId, userId, slug);
    await recordAudit({
      userId,
      companyId,
      action: "template.applied",
      entityType: "template",
      entityId: slug,
      metadata: { summary: data.summary },
      ...extractRequestMeta(req),
    });
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function applications(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await listCompanyApplications(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function revert(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId, role } = auth(req);
    if (role !== "owner" && role !== "admin") {
      return res.status(403).json({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: "Only owners and admins can revert template applications.",
        },
      });
    }
    const id = req.params.id as string;
    const data = await revertApplication(companyId, id);
    await recordAudit({
      userId,
      companyId,
      action: "template.application_reverted",
      entityType: "template_application",
      entityId: id,
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
