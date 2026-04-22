import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as ChatSvc from "../services/chat.service";
import type { AuthenticatedRequest } from "../types";
import { recordAudit, extractRequestMeta } from "../utils/audit";

const sendSchema = z.object({
  toUserId: z.string().min(1),
  content: z.string().min(1).max(5000),
});

const conversationSchema = z.object({
  since: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

export async function threads(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId, userId } = auth(req);
    const data = await ChatSvc.listThreads(companyId, userId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function team(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const data = await ChatSvc.listTeam(companyId, userId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function conversation(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId, userId } = auth(req);
    const partnerId = req.params.userId as string;
    const q = conversationSchema.parse(req.query);
    const data = await ChatSvc.getConversation(
      companyId,
      userId,
      partnerId,
      q
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function send(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const dto = sendSchema.parse(req.body);
    const data = await ChatSvc.sendMessage(
      companyId,
      userId,
      dto as ChatSvc.SendMessageDto
    );
    const created = data as unknown as { id?: string } | null;
    recordAudit({
      userId,
      companyId,
      action: "chatMessage.create",
      entityType: "chatMessage",
      entityId: created?.id ?? null,
      after: data,
      ...extractRequestMeta(req),
    }).catch(() => {});
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function unreadCount(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId, userId } = auth(req);
    const data = await ChatSvc.getUnreadCount(companyId, userId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
