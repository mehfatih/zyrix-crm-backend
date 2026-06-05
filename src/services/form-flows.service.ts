// ============================================================================
// FORM FLOWS SERVICE — Sprint 12
// ----------------------------------------------------------------------------
// CRUD for no-code multi-step forms used as internal wizards or public kiosks.
// The submit pipeline (Phase B) lives in form-submit.service. The WRITABLE
// whitelists below are the defense-in-depth boundary: regardless of what a
// flow's stored mapping says, public input can ONLY ever write these fields.
// ============================================================================

import crypto from "crypto";
import { prisma } from "../config/database";
import { badRequest, notFound } from "../middleware/errorHandler";

export type FieldType =
  | "text" | "phone" | "email" | "select" | "multi_select"
  | "date" | "number" | "textarea" | "consent";

export interface FormField {
  key: string;
  type: FieldType;
  label_en: string;
  label_ar?: string;
  label_tr?: string;
  required?: boolean;
  options?: string[]; // for select / multi_select
}
export interface FormStep {
  title: string;
  title_ar?: string;
  title_tr?: string;
  fields: FormField[];
}
export interface FormMapping {
  // form field key -> contact field (whitelisted) OR "custom:<key>"
  contact?: Record<string, string>;
  // form field key -> deal field (whitelisted)
  deal?: Record<string, string>;
  createDeal?: { enabled: boolean; stage?: string; titleTemplate?: string };
}
export interface FlowTheme {
  logoUrl?: string;
  accent?: string;
  welcomeText?: { en?: string; ar?: string; tr?: string };
  thankYouText?: { en?: string; ar?: string; tr?: string };
}

// Defense-in-depth: the ONLY contact/deal fields public input may write.
export const CONTACT_WRITABLE = new Set([
  "fullName", "email", "phone", "whatsappPhone", "companyName",
  "position", "country", "city", "address", "notes",
]);
export const DEAL_WRITABLE = new Set(["title", "value", "currency", "stage", "description"]);
// Never writable from form input.
export const SENSITIVE_BLACKLIST = new Set([
  "ownerId", "lifetimeValue", "leadScore", "healthScore", "territory",
  "aiExtracted", "externalId", "status", "companyId", "brandId", "id",
]);

function parse<T>(raw: string | null, fb: T): T {
  if (!raw) return fb;
  try { return JSON.parse(raw) as T; } catch { return fb; }
}

function shape(row: any) {
  return {
    ...row,
    steps: parse<FormStep[]>(row.steps, []),
    mapping: parse<FormMapping>(row.mapping, {}),
    theme: row.theme ? parse<FlowTheme>(row.theme, {}) : null,
  };
}

function genToken(): string {
  return crypto.randomBytes(18).toString("hex");
}

// Validate the flow definition itself (not submission data).
function validateDefinition(steps: FormStep[], mapping: FormMapping): void {
  if (!Array.isArray(steps) || steps.length === 0) throw badRequest("A flow needs at least one step");
  const keys = new Set<string>();
  for (const s of steps) {
    for (const f of s.fields ?? []) {
      if (!f.key || !/^[a-zA-Z0-9_]+$/.test(f.key)) throw badRequest(`Invalid field key: ${f.key}`);
      if (keys.has(f.key)) throw badRequest(`Duplicate field key: ${f.key}`);
      keys.add(f.key);
    }
  }
  // Reject any mapping target that is blacklisted or not whitelisted.
  for (const target of Object.values(mapping.contact ?? {})) {
    if (target.startsWith("custom:")) continue;
    if (SENSITIVE_BLACKLIST.has(target) || !CONTACT_WRITABLE.has(target)) {
      throw badRequest(`Contact field "${target}" is not allowed for form mapping`);
    }
  }
  for (const target of Object.values(mapping.deal ?? {})) {
    if (SENSITIVE_BLACKLIST.has(target) || !DEAL_WRITABLE.has(target)) {
      throw badRequest(`Deal field "${target}" is not allowed for form mapping`);
    }
  }
}

export interface FlowDto {
  name: string;
  mode?: "internal" | "public";
  steps: FormStep[];
  mapping: FormMapping;
  theme?: FlowTheme | null;
  kioskMode?: boolean;
}

export async function listFlows(companyId: string) {
  const rows = await prisma.formFlow.findMany({ where: { companyId }, orderBy: { updatedAt: "desc" } });
  const counts = await prisma.formSubmission.groupBy({
    by: ["flowId"],
    where: { companyId },
    _count: { _all: true },
  });
  const cmap = new Map(counts.map((c) => [c.flowId, c._count._all]));
  return rows.map((r) => ({ ...shape(r), submissionCount: cmap.get(r.id) ?? 0 }));
}

export async function getFlow(companyId: string, id: string) {
  const row = await prisma.formFlow.findFirst({ where: { id, companyId } });
  if (!row) throw notFound("Form flow");
  return shape(row);
}

export async function createFlow(companyId: string, dto: FlowDto) {
  if (!dto.name?.trim()) throw badRequest("name is required");
  validateDefinition(dto.steps ?? [], dto.mapping ?? {});
  const mode = dto.mode === "public" ? "public" : "internal";
  const row = await prisma.formFlow.create({
    data: {
      companyId,
      name: dto.name.trim(),
      mode,
      steps: JSON.stringify(dto.steps ?? []),
      mapping: JSON.stringify(dto.mapping ?? {}),
      theme: dto.theme ? JSON.stringify(dto.theme) : null,
      kioskMode: !!dto.kioskMode,
      publicToken: mode === "public" ? genToken() : null,
      status: "draft",
    },
  });
  return shape(row);
}

export async function updateFlow(companyId: string, id: string, patch: Partial<FlowDto>) {
  const existing = await getFlow(companyId, id);
  const steps = patch.steps ?? existing.steps;
  const mapping = patch.mapping ?? existing.mapping;
  if (patch.steps !== undefined || patch.mapping !== undefined) validateDefinition(steps, mapping);
  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) data.name = patch.name.trim();
  if (patch.steps !== undefined) data.steps = JSON.stringify(patch.steps);
  if (patch.mapping !== undefined) data.mapping = JSON.stringify(patch.mapping);
  if (patch.theme !== undefined) data.theme = patch.theme ? JSON.stringify(patch.theme) : null;
  if (patch.kioskMode !== undefined) data.kioskMode = !!patch.kioskMode;
  if (patch.mode !== undefined) {
    data.mode = patch.mode;
    // Ensure a public token exists when switching to public.
    if (patch.mode === "public" && !existing.publicToken) data.publicToken = genToken();
  }
  const row = await prisma.formFlow.update({ where: { id }, data });
  return shape(row);
}

export async function setStatus(companyId: string, id: string, status: "active" | "archived" | "draft") {
  const flow = await getFlow(companyId, id);
  if (status === "active") {
    validateDefinition(flow.steps, flow.mapping);
    // A public flow must have a token to be activated.
    if (flow.mode === "public" && !flow.publicToken) {
      await prisma.formFlow.update({ where: { id }, data: { publicToken: genToken() } });
    }
  }
  const row = await prisma.formFlow.update({ where: { id }, data: { status } });
  return shape(row);
}

export async function regenerateToken(companyId: string, id: string) {
  await getFlow(companyId, id);
  const row = await prisma.formFlow.update({ where: { id }, data: { publicToken: genToken() } });
  return shape(row);
}

export async function deleteFlow(companyId: string, id: string) {
  await getFlow(companyId, id);
  await prisma.formFlow.delete({ where: { id } });
  return { id, deleted: true };
}

export async function listSubmissions(companyId: string, flowId: string, limit = 200) {
  await getFlow(companyId, flowId);
  const rows = await prisma.formSubmission.findMany({
    where: { companyId, flowId },
    orderBy: { createdAt: "desc" },
    take: Math.min(500, limit),
  });
  return rows.map((r) => ({ ...r, data: parse<Record<string, unknown>>(r.data, {}) }));
}
