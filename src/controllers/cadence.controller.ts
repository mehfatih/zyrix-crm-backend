import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as Cad from "../services/cadence.service";
import type { AuthenticatedRequest } from "../types";

// ============================================================================
// CADENCE CONTROLLER — Sprint 11
// ============================================================================

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

const stepSchema = z.object({
  channel: z.enum(["whatsapp", "email", "task", "call_task"]),
  delayDays: z.coerce.number().min(0).max(365).optional(),
  delayHours: z.coerce.number().min(0).max(23).optional(),
  name: z.string().max(200).optional(),
  templateRef: z.object({ name: z.string(), lang: z.string().optional() }).optional(),
  subject: z.string().max(500).optional(),
  body: z.string().max(20000).optional(),
});

const exitRulesSchema = z.object({
  onReply: z.boolean().optional(),
  onDealWon: z.boolean().optional(),
  onUnsubscribe: z.boolean().optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional().nullable(),
  steps: z.array(stepSchema).default([]),
  exitRules: exitRulesSchema.optional(),
});
const updateSchema = createSchema.partial();

const enrollSchema = z.object({
  contactIds: z.array(z.string()).optional(),
  tagId: z.string().optional(),
});

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json({ success: true, data: await Cad.listCadences(auth(req).companyId) });
  } catch (err) { next(err); }
}

export async function getOne(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json({ success: true, data: await Cad.getCadence(auth(req).companyId, req.params.id as string) });
  } catch (err) { next(err); }
}

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const dto = createSchema.parse(req.body);
    res.status(201).json({ success: true, data: await Cad.createCadence(auth(req).companyId, dto as Cad.CadenceDto) });
  } catch (err) { next(err); }
}

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const dto = updateSchema.parse(req.body);
    res.status(200).json({ success: true, data: await Cad.updateCadence(companyId, userId, req.params.id as string, dto as Partial<Cad.CadenceDto>) });
  } catch (err) { next(err); }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json({ success: true, data: await Cad.deleteCadence(auth(req).companyId, req.params.id as string) });
  } catch (err) { next(err); }
}

export async function activate(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    res.status(200).json({ success: true, data: await Cad.activateCadence(companyId, userId, req.params.id as string) });
  } catch (err) { next(err); }
}

export async function pause(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json({ success: true, data: await Cad.pauseCadence(auth(req).companyId, req.params.id as string) });
  } catch (err) { next(err); }
}

export async function enroll(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const id = req.params.id as string;
    const dto = enrollSchema.parse(req.body);
    let data;
    if (dto.tagId) {
      data = await Cad.enrollByTag(companyId, userId, id, dto.tagId);
    } else {
      data = await Cad.enrollContacts(companyId, userId, id, dto.contactIds ?? []);
    }
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

export async function unenroll(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json({ success: true, data: await Cad.unenroll(auth(req).companyId, req.params.enrollmentId as string) });
  } catch (err) { next(err); }
}

export async function smartFollowupStatus(req: Request, res: Response, next: NextFunction) {
  try {
    auth(req);
    res.status(200).json({ success: true, data: { onEngine: Cad.smartFollowupOnEngine() } });
  } catch (err) { next(err); }
}

export async function seedSmartFollowup(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    res.status(200).json({ success: true, data: await Cad.seedSmartFollowupPreset(companyId, userId) });
  } catch (err) { next(err); }
}

export async function funnel(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json({ success: true, data: await Cad.getCadenceFunnel(auth(req).companyId, req.params.id as string) });
  } catch (err) { next(err); }
}

export async function contactEnrollments(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json({ success: true, data: await Cad.enrollmentsForContact(auth(req).companyId, req.params.contactId as string) });
  } catch (err) { next(err); }
}
