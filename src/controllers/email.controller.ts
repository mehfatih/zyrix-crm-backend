import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as Q from "../services/email-query.service";
import { generateEmailDraft, generateReplyDraft, type DraftGoal } from "../services/email-ai.service";
import type { AuthenticatedRequest } from "../types";

// ============================================================================
// EMAIL CONTROLLER — Sprint 10 (contact timeline, compose, AI draft, best-time)
// ============================================================================

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

export async function listContactEmails(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await Q.listContactEmails(companyId, req.params.contactId as string);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

export async function getEmail(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await Q.getEmail(companyId, req.params.id as string);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

export async function bestSendTime(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await Q.bestSendTime(companyId, req.params.contactId as string);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

const composeSchema = z.object({
  contactId: z.string().min(1),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(20000),
});

export async function send(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const dto = composeSchema.parse(req.body);
    const data = await Q.composeAndSend(companyId, userId, dto as Q.ComposeInput);
    res.status(201).json({ success: true, data });
  } catch (err) { next(err); }
}

const draftSchema = z.object({
  contactId: z.string().min(1),
  goal: z.enum(["follow_up", "proposal_nudge", "re_engage"]),
});

export async function aiDraft(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = draftSchema.parse(req.body);
    const data = await generateEmailDraft(companyId, dto.contactId, dto.goal as DraftGoal);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

// Sprint 15C — on-demand AI suggested reply to a customer's inbound email.
export async function replyAi(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await generateReplyDraft(companyId, req.params.id as string);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}
