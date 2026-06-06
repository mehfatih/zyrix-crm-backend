import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import { badRequest } from "../middleware/errorHandler";
import * as Tickets from "../services/ticket.service";
import * as conv from "../services/whatsapp/conversations.service";
import { sendText, sendTemplate } from "../services/whatsapp/send";
import { sendMessage as sendMetaMessage } from "../services/meta-messaging/send";
import { composeAndSend } from "../services/email-query.service";
import { listContactEmails } from "../services/email-query.service";
import { listPolicies } from "../services/sla.service";

// ============================================================================
// SERVICE DESK — TICKETS CONTROLLER (/api/tickets, session auth)
// ============================================================================

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId, role: r.user.role };
}

// ── Queue ───────────────────────────────────────────────────────────────
export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const q = req.query;
    const data = await Tickets.listTickets(companyId, {
      status: typeof q.status === "string" ? q.status : undefined,
      mine: q.mine === "true" ? userId : undefined,
      unassigned: q.unassigned === "true",
      channel: typeof q.channel === "string" ? q.channel : undefined,
      breachingSoon: q.breachingSoon === "true",
      assigneeId: typeof q.assigneeId === "string" ? q.assigneeId : undefined,
      limit: q.limit ? Number(q.limit) : undefined,
    });
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

export async function counts(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const data = await Tickets.getCounts(companyId, userId);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

// ── Detail (ticket + audit events + the original thread) ──────────────────
export async function getOne(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const id = String(req.params.id);
    const ticket = await Tickets.getTicket(companyId, id);
    if (!ticket) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Ticket not found" } });
    }
    const events = await Tickets.listTicketEvents(companyId, id);

    // The thread = the original channel surface (reused, read via existing svc).
    let thread: { kind: string; messages: unknown[] } = { kind: "none", messages: [] };
    if (ticket.conversationId) {
      const messages = await conv.getMessages(companyId, ticket.conversationId);
      thread = { kind: "conversation", messages };
    } else if (ticket.channel === "email" && ticket.customerId) {
      const emails: any = await listContactEmails(companyId, ticket.customerId);
      thread = { kind: "email", messages: emails?.messages ?? [] };
    }

    res.status(200).json({ success: true, data: { ticket, events, thread } });
  } catch (err) { next(err); }
}

// ── Update status / priority / assignee ───────────────────────────────────
const updateSchema = z.object({
  status: z.enum(["new", "open", "pending", "resolved", "closed"]).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
});

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const dto = updateSchema.parse(req.body);
    const data = await Tickets.updateTicket(companyId, String(req.params.id), userId, dto);
    if (!data) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Ticket not found" } });
    }
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

/** "Take it" — assign the ticket to the current agent. */
export async function takeIt(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const data = await Tickets.updateTicket(companyId, String(req.params.id), userId, { assigneeId: userId });
    if (!data) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Ticket not found" } });
    }
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

// ── Reply via the original channel (reuse existing send paths) ─────────────
const replySchema = z.object({
  text: z.string().min(1).max(20000),
  tag: z.string().optional(), // Messenger/IG message tag (outside 24h window)
});

export async function reply(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const id = String(req.params.id);
    const { text, tag } = replySchema.parse(req.body);
    const ticket = await Tickets.getTicket(companyId, id);
    if (!ticket) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Ticket not found" } });
    }

    let result: { channel: string; ref: string | null } = { channel: ticket.channel, ref: null };

    if (ticket.channel === "whatsapp") {
      if (!ticket.conversationId) throw badRequest("Ticket has no linked conversation");
      const r = await sendText(companyId, ticket.conversationId, text.trim(), userId);
      result.ref = r.messageId;
    } else if (ticket.channel === "messenger" || ticket.channel === "instagram") {
      if (!ticket.conversationId) throw badRequest("Ticket has no linked conversation");
      const r = await sendMetaMessage(companyId, ticket.conversationId, text.trim(), userId, tag ?? null);
      result.ref = r.messageId;
    } else if (ticket.channel === "email") {
      if (!ticket.customerId) throw badRequest("Ticket has no linked contact to email");
      const subject = ticket.subject ? `Re: ${ticket.subject}` : `Re: ticket #${ticket.number}`;
      const r: any = await composeAndSend(companyId, userId, {
        contactId: ticket.customerId,
        subject: subject.slice(0, 500),
        body: text.trim(),
      });
      result.ref = r?.id ?? r?.emailId ?? null;
    } else {
      return res.status(400).json({
        success: false,
        error: { code: "NO_OUTBOUND_CHANNEL", message: `Cannot reply on a '${ticket.channel}' ticket` },
      });
    }

    await Tickets.recordOutboundReply(companyId, id, userId);
    res.status(200).json({ success: true, data: result });
  } catch (err) { next(err); }
}

// ── Settings (one-click enable) ────────────────────────────────────────────
export async function getSettings(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await Tickets.getSettings(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

export async function slaPolicies(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await listPolicies(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  autoCreate: z.boolean().optional(),
  defaultSlaPolicyId: z.string().uuid().nullable().optional(),
});

export async function updateSettings(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = settingsSchema.parse(req.body);
    const data = await Tickets.updateSettings(companyId, dto);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

// ── Manual create (agent opens a ticket by hand) ───────────────────────────
const createSchema = z.object({
  customerId: z.string().uuid().optional(),
  subject: z.string().min(1).max(200),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
});

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const dto = createSchema.parse(req.body);
    const data = await Tickets.createTicket({
      companyId,
      customerId: dto.customerId ?? null,
      channel: "manual",
      subject: dto.subject,
      priority: dto.priority,
      actorUserId: userId,
    });
    res.status(201).json({ success: true, data });
  } catch (err) { next(err); }
}
