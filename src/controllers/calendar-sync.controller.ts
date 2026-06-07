import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types";
import { env } from "../config/env";
import {
  buildCalendarAuthUrl,
  completeCalendarConnect,
  listConnections,
  disconnect,
} from "../services/calendar-sync.service";

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

function settingsUrl(status: string): string {
  const base = (env.APP_URL || "https://crm.zyrix.co").replace(/\/$/, "");
  return `${base}/en/settings/calendar?calendar=${status}`;
}

export async function calendarConnect(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    res.json({ success: true, data: { authUrl: buildCalendarAuthUrl(companyId, userId) } });
  } catch (e) { next(e); }
}

// PUBLIC — Google redirects the browser here (no auth header).
export async function calendarCallback(req: Request, res: Response) {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  if (!code || !state) return res.redirect(settingsUrl("error"));
  try {
    await completeCalendarConnect(code, state);
    res.redirect(settingsUrl("connected"));
  } catch (e) {
    console.error("[calendar-sync] callback failed:", (e as Error).message);
    res.redirect(settingsUrl("error"));
  }
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    res.json({ success: true, data: await listConnections(companyId) });
  } catch (e) { next(e); }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    await disconnect(companyId, String(req.params.id));
    res.json({ success: true, data: { deleted: true } });
  } catch (e) { next(e); }
}
