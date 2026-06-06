import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import { env } from "../config/env";
import {
  buildGmailAuthUrl,
  completeGmailConnect,
  connectImap,
  listConnections,
  disconnect,
  pollConnection,
} from "../services/email-inbox.service";
import { prisma } from "../config/database";

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

function settingsUrl(status: string): string {
  const base = (env.APP_URL || "https://crm.zyrix.co").replace(/\/$/, "");
  return `${base}/en/settings/integrations?inbox=${status}`;
}

export async function gmailConnect(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    res.json({ success: true, data: { authUrl: buildGmailAuthUrl(companyId, userId) } });
  } catch (e) { next(e); }
}

// PUBLIC — Google redirects the browser here (no auth header).
export async function gmailCallback(req: Request, res: Response) {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  if (!code || !state) return res.redirect(settingsUrl("error"));
  try {
    await completeGmailConnect(code, state);
    res.redirect(settingsUrl("connected"));
  } catch (e) {
    console.error("[email-inbox] gmail callback failed:", (e as Error).message);
    res.redirect(settingsUrl("error"));
  }
}

const imapSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535),
  user: z.string().min(1),
  appPassword: z.string().min(1),
  tls: z.boolean().optional(),
});

export async function imapConnect(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const dto = imapSchema.parse(req.body);
    const data = await connectImap(companyId, userId, {
      host: dto.host, port: dto.port, user: dto.user, appPassword: dto.appPassword, tls: dto.tls,
    });
    res.status(201).json({ success: true, data });
  } catch (e) { next(e); }
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

export async function syncNow(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const id = String(req.params.id);
    const conn = await prisma.emailInboxConnection.findFirst({ where: { id, companyId }, select: { id: true } });
    if (!conn) return res.status(404).json({ success: false, error: { message: "Connection not found" } });
    await pollConnection(id);
    res.json({ success: true, data: { synced: true } });
  } catch (e) { next(e); }
}
