import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as J from "../services/journey.service";
import type { AuthenticatedRequest } from "../types";

// ============================================================================
// JOURNEY CONTROLLER — Sprint 11 (visual multi-channel canvas)
// ============================================================================

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

const nodeSchema = z.object({
  id: z.string(),
  type: z.enum(["trigger", "message", "wait", "branch", "assign", "tag", "end"]),
  x: z.coerce.number(),
  y: z.coerce.number(),
  config: z.record(z.any()).default({}),
});
const edgeSchema = z.object({ from: z.string(), to: z.string(), label: z.string().optional() });
const canvasSchema = z.object({ nodes: z.array(nodeSchema).default([]), edges: z.array(edgeSchema).default([]) });

export async function list(req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json({ success: true, data: await J.listJourneys(auth(req).companyId) }); } catch (e) { next(e); }
}
export async function getOne(req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json({ success: true, data: await J.getJourney(auth(req).companyId, req.params.id as string) }); } catch (e) { next(e); }
}
export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const dto = z.object({ name: z.string().min(1).max(200), canvas: canvasSchema.optional() }).parse(req.body);
    res.status(201).json({ success: true, data: await J.createJourney(companyId, userId, dto as any) });
  } catch (e) { next(e); }
}
export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const dto = z.object({ name: z.string().min(1).max(200).optional(), canvas: canvasSchema.optional() }).parse(req.body);
    res.status(200).json({ success: true, data: await J.updateJourney(auth(req).companyId, req.params.id as string, dto as any) });
  } catch (e) { next(e); }
}
export async function remove(req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json({ success: true, data: await J.deleteJourney(auth(req).companyId, req.params.id as string) }); } catch (e) { next(e); }
}
export async function activate(req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json({ success: true, data: await J.setJourneyEnabled(auth(req).companyId, req.params.id as string, true) }); } catch (e) { next(e); }
}
export async function pause(req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json({ success: true, data: await J.setJourneyEnabled(auth(req).companyId, req.params.id as string, false) }); } catch (e) { next(e); }
}
export async function validate(req: Request, res: Response, next: NextFunction) {
  try {
    const dto = z.object({ canvas: canvasSchema }).parse(req.body);
    res.status(200).json({ success: true, data: J.validateCanvas(dto.canvas as J.Canvas) });
  } catch (e) { next(e); }
}
export async function testRun(req: Request, res: Response, next: NextFunction) {
  try {
    const dto = z.object({ canvas: canvasSchema, sample: z.record(z.any()).default({}) }).parse(req.body);
    res.status(200).json({ success: true, data: { path: J.testRunPath(dto.canvas as J.Canvas, dto.sample) } });
  } catch (e) { next(e); }
}
