import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as CampaignSvc from "../services/campaigns.service";
import type { AuthenticatedRequest } from "../types";
import { recordAudit, extractRequestMeta, diffObjects } from "../utils/audit";

const createSchema = z.object({
  name: z.string().min(1).max(200),
  subject: z.string().max(500).optional(),
  channel: z.enum(["email", "whatsapp", "sms"]),
  bodyHtml: z.string().max(500000).optional(),
  bodyText: z.string().max(200000).optional(),
  fromName: z.string().max(200).optional(),
  fromEmail: z.string().email().optional(),
  replyTo: z.string().email().optional(),
  targetType: z.enum(["all", "status", "tag", "manual"]).optional(),
  targetValue: z.string().max(200).optional(),
  scheduledAt: z.coerce.date().optional().nullable(),
  customerIds: z.array(z.string()).optional(),
});

const updateSchema = createSchema.partial();

const listSchema = z.object({
  status: z
    .enum(["draft", "scheduled", "sending", "sent", "failed", "cancelled"])
    .optional(),
  channel: z.enum(["email", "whatsapp", "sms"]).optional(),
  page: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
});

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const q = listSchema.parse(req.query);
    const data = await CampaignSvc.listCampaigns(companyId, q);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function getOne(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await CampaignSvc.getCampaign(
      companyId,
      req.params.id as string
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const dto = createSchema.parse(req.body);
    const data = await CampaignSvc.createCampaign(
      companyId,
      userId,
      dto as CampaignSvc.CreateCampaignDto
    );
    const created = data as unknown as { id?: string } | null;
    recordAudit({
      userId,
      companyId,
      action: "campaign.create",
      entityType: "campaign",
      entityId: created?.id ?? null,
      after: data,
      ...extractRequestMeta(req),
    }).catch(() => {});
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const id = req.params.id as string;
    const dto = updateSchema.parse(req.body);
    const before = await CampaignSvc.getCampaign(companyId, id).catch(() => null);
    const data = await CampaignSvc.updateCampaign(
      companyId,
      id,
      dto as CampaignSvc.UpdateCampaignDto
    );
    const beforeStatus =
      (before as unknown as { status?: string } | null)?.status ?? null;
    const afterStatus =
      (data as unknown as { status?: string } | null)?.status ?? null;
    const statusChanged =
      beforeStatus !== null && afterStatus !== null && beforeStatus !== afterStatus;

    recordAudit({
      userId,
      companyId,
      action: "campaign.update",
      entityType: "campaign",
      entityId: id,
      before,
      after: data,
      changes: before
        ? diffObjects(
            before as unknown as Record<string, unknown>,
            data as unknown as Record<string, unknown>
          )
        : null,
      ...extractRequestMeta(req),
    }).catch(() => {});

    if (statusChanged) {
      recordAudit({
        userId,
        companyId,
        action: "campaign.status_changed",
        entityType: "campaign",
        entityId: id,
        before,
        after: data,
        metadata: { from: beforeStatus, to: afterStatus },
        ...extractRequestMeta(req),
      }).catch(() => {});
    }

    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const id = req.params.id as string;
    const before = await CampaignSvc.getCampaign(companyId, id).catch(() => null);
    const data = await CampaignSvc.deleteCampaign(companyId, id);
    recordAudit({
      userId,
      companyId,
      action: "campaign.delete",
      entityType: "campaign",
      entityId: id,
      before,
      ...extractRequestMeta(req),
    }).catch(() => {});
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function send(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const id = req.params.id as string;
    const before = await CampaignSvc.getCampaign(companyId, id).catch(() => null);
    const data = await CampaignSvc.sendCampaign(companyId, id);
    const beforeStatus =
      (before as unknown as { status?: string } | null)?.status ?? null;
    const afterStatus =
      (data as unknown as { status?: string } | null)?.status ?? null;
    recordAudit({
      userId,
      companyId,
      action: "campaign.status_changed",
      entityType: "campaign",
      entityId: id,
      before,
      after: data,
      metadata: { from: beforeStatus, to: afterStatus, trigger: "send" },
      ...extractRequestMeta(req),
    }).catch(() => {});
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function stats(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await CampaignSvc.getCampaignStats(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
