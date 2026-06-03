import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types";
import { verifyAccessToken } from "../utils/jwt";
import { badRequest, notFound } from "../middleware/errorHandler";
import * as convo from "../services/support/conversation";
import { openSse } from "./support.controller";

// ============================================================================
// ZYRIX SUPPORT CONSOLE CONTROLLER (/api/admin/support-console) — super-admin
// ----------------------------------------------------------------------------
// Distinct from the existing support_tickets admin (/api/admin/tickets). Live
// AI-chat queue: claim, real-time reply (SSE), full thread + AI history +
// survey. Mounted behind requireSuperAdmin.
// ============================================================================

function admin(req: Request) {
  const r = req as AuthenticatedRequest;
  return { adminId: r.user.userId };
}

// GET /queue?status=awaiting_human|human|closed|all
export async function queue(req: Request, res: Response, next: NextFunction) {
  try {
    const status = (typeof req.query.status === "string" ? req.query.status : "all") as
      | "open_ai"
      | "awaiting_human"
      | "human"
      | "closed"
      | "all";
    const rows = await convo.listQueue(status, 100);
    res.status(200).json({ success: true, data: { conversations: rows } });
  } catch (err) {
    next(err);
  }
}

// GET /:id — full thread + survey
export async function thread(req: Request, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    const conv = await convo.getById(id);
    if (!conv) throw notFound("Conversation");
    const [msgs, survey] = await Promise.all([convo.listMessages(id), convo.getSurvey(id)]);
    res.status(200).json({ success: true, data: { conversation: conv, messages: msgs, survey } });
  } catch (err) {
    next(err);
  }
}

// POST /:id/claim
export async function claim(req: Request, res: Response, next: NextFunction) {
  try {
    const { adminId } = admin(req);
    const id = String(req.params.id);
    const conv = await convo.getById(id);
    if (!conv) throw notFound("Conversation");
    await convo.claim(id, adminId);
    res.status(200).json({ success: true, data: { status: "human", assignedAdminId: adminId } });
  } catch (err) {
    next(err);
  }
}

// POST /:id/reply — body { text }. Human reply (AI is silent while human-handled).
export async function reply(req: Request, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    const conv = await convo.getById(id);
    if (!conv) throw notFound("Conversation");
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) throw badRequest("Reply text is required");
    const msg = await convo.appendMessage(id, "human", text);
    res.status(200).json({ success: true, data: { id: msg.id } });
  } catch (err) {
    next(err);
  }
}

// POST /:id/close
export async function close(req: Request, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    const conv = await convo.getById(id);
    if (!conv) throw notFound("Conversation");
    await convo.closeConversation(id);
    res.status(200).json({ success: true, data: { status: "closed" } });
  } catch (err) {
    next(err);
  }
}

// GET /:id/stream — admin SSE. Auth via ?token= (super_admin), EventSource-safe.
export async function stream(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);
  const token = typeof req.query.token === "string" ? req.query.token : "";
  try {
    const decoded = verifyAccessToken(token);
    if (decoded.role !== "super_admin") {
      res.status(403).end();
      return;
    }
  } catch {
    res.status(401).end();
    return;
  }
  const conv = await convo.getById(id);
  if (!conv) {
    res.status(404).end();
    return;
  }
  openSse(req, res, id);
}
