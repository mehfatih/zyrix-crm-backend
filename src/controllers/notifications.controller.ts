import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import {
  listNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification,
} from "../services/notifications.service";

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, companyId } = auth(req);
    const onlyUnread = req.query.onlyUnread === "true";
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const offset = req.query.offset ? Number(req.query.offset) : 0;
    const items = await listNotifications(companyId, userId, {
      onlyUnread,
      limit,
      offset,
    });
    const unreadCount = await getUnreadCount(companyId, userId);
    res.status(200).json({ success: true, data: { items, unreadCount } });
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
    const { userId, companyId } = auth(req);
    const count = await getUnreadCount(companyId, userId);
    res.status(200).json({ success: true, data: { count } });
  } catch (err) {
    next(err);
  }
}

const markReadSchema = z.object({
  ids: z.array(z.string().uuid()).optional(),
  all: z.boolean().optional(),
});

export async function markRead(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const dto = markReadSchema.parse(req.body);
    if (dto.all) {
      const data = await markAllAsRead(companyId, userId);
      return res.status(200).json({ success: true, data });
    }
    const data = await markAsRead(companyId, userId, dto.ids ?? []);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function remove(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const data = await deleteNotification(
      companyId,
      userId,
      req.params.id as string
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
