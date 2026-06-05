import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import QRCode from "qrcode";
import * as Flows from "../services/form-flows.service";
import { submitForm } from "../services/form-submit.service";
import { env } from "../config/env";
import type { AuthenticatedRequest } from "../types";

// ============================================================================
// FORM FLOWS CONTROLLER — Sprint 12 (authenticated builder surface)
// ============================================================================

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

function publicFormUrl(token: string): string {
  const base = (env.APP_URL || "https://crm.zyrix.co").replace(/\/$/, "");
  return `${base}/ar/f/${token}`; // MENA-first default; the page is locale-aware
}

const fieldSchema = z.object({
  key: z.string().min(1).max(60),
  type: z.enum(["text", "phone", "email", "select", "multi_select", "date", "number", "textarea", "consent"]),
  label_en: z.string().max(200),
  label_ar: z.string().max(200).optional(),
  label_tr: z.string().max(200).optional(),
  required: z.boolean().optional(),
  options: z.array(z.string()).optional(),
});
const stepSchema = z.object({
  title: z.string().max(200),
  title_ar: z.string().max(200).optional(),
  title_tr: z.string().max(200).optional(),
  fields: z.array(fieldSchema).default([]),
});
const mappingSchema = z.object({
  contact: z.record(z.string()).optional(),
  deal: z.record(z.string()).optional(),
  createDeal: z.object({ enabled: z.boolean(), stage: z.string().optional(), titleTemplate: z.string().optional() }).optional(),
});
const themeSchema = z.object({
  logoUrl: z.string().optional(),
  accent: z.string().optional(),
  welcomeText: z.object({ en: z.string().optional(), ar: z.string().optional(), tr: z.string().optional() }).optional(),
  thankYouText: z.object({ en: z.string().optional(), ar: z.string().optional(), tr: z.string().optional() }).optional(),
}).nullable();

const createSchema = z.object({
  name: z.string().min(1).max(200),
  mode: z.enum(["internal", "public"]).optional(),
  steps: z.array(stepSchema).default([]),
  mapping: mappingSchema.default({}),
  theme: themeSchema.optional(),
  kioskMode: z.boolean().optional(),
});
const updateSchema = createSchema.partial();

export async function list(req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json({ success: true, data: await Flows.listFlows(auth(req).companyId) }); } catch (e) { next(e); }
}
export async function getOne(req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json({ success: true, data: await Flows.getFlow(auth(req).companyId, req.params.id as string) }); } catch (e) { next(e); }
}
export async function create(req: Request, res: Response, next: NextFunction) {
  try { res.status(201).json({ success: true, data: await Flows.createFlow(auth(req).companyId, createSchema.parse(req.body) as Flows.FlowDto) }); } catch (e) { next(e); }
}
export async function update(req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json({ success: true, data: await Flows.updateFlow(auth(req).companyId, req.params.id as string, updateSchema.parse(req.body) as Partial<Flows.FlowDto>) }); } catch (e) { next(e); }
}
export async function remove(req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json({ success: true, data: await Flows.deleteFlow(auth(req).companyId, req.params.id as string) }); } catch (e) { next(e); }
}
export async function activate(req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json({ success: true, data: await Flows.setStatus(auth(req).companyId, req.params.id as string, "active") }); } catch (e) { next(e); }
}
export async function archive(req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json({ success: true, data: await Flows.setStatus(auth(req).companyId, req.params.id as string, "archived") }); } catch (e) { next(e); }
}
export async function regenerateToken(req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json({ success: true, data: await Flows.regenerateToken(auth(req).companyId, req.params.id as string) }); } catch (e) { next(e); }
}
export async function submissions(req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json({ success: true, data: await Flows.listSubmissions(auth(req).companyId, req.params.id as string) }); } catch (e) { next(e); }
}

// Internal wizard submit (authenticated staff) — source='internal'.
export async function internalSubmit(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const flow = await Flows.getFlow(companyId, req.params.id as string);
    const body = req.body ?? {};
    const result = await submitForm(
      { companyId, flow: { id: flow.id, name: flow.name, steps: flow.steps, mapping: flow.mapping }, source: "internal", submittedBy: userId },
      { data: body.data ?? {}, honeypot: body.honeypot, elapsedMs: Number(body.elapsedMs) }
    );
    res.status(201).json({ success: true, data: result });
  } catch (e) { next(e); }
}

export async function qr(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const flow = await Flows.getFlow(companyId, req.params.id as string);
    if (!flow.publicToken) { res.status(400).json({ success: false, error: { code: "NO_TOKEN", message: "Flow has no public token" } }); return; }
    const url = publicFormUrl(flow.publicToken);
    if (req.query.format === "svg") {
      const svg = await QRCode.toString(url, { type: "svg", margin: 1, width: 320 });
      res.type("image/svg+xml").send(svg);
      return;
    }
    const png = await QRCode.toBuffer(url, { type: "png", margin: 1, width: 320, errorCorrectionLevel: "M" });
    res.type("image/png").send(png);
  } catch (e) { next(e); }
}
