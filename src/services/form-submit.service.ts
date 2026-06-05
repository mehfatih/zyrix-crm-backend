// ============================================================================
// FORM SUBMIT PIPELINE — Sprint 12
// ----------------------------------------------------------------------------
// Public + internal form submission: validate against the flow definition,
// anti-spam (honeypot + min-fill-time), map ONLY whitelisted fields → dedupe
// contact upsert (same rule as lead ingest) + optional deal, write a submission
// row, emit form.submitted. The writable whitelist is re-enforced here even
// though the builder already validated the mapping (defense in depth).
// ============================================================================

import { prisma } from "../config/database";
import { notFound, badRequest } from "../middleware/errorHandler";
import { normalizeE164, dialCodeForCountry } from "./google-ads/map";
import { recordIntegrationEvent } from "./integration-events.service";
import { dispatchFormSubmitted } from "./workflow-events.service";
import {
  CONTACT_WRITABLE, DEAL_WRITABLE, SENSITIVE_BLACKLIST,
  type FormStep, type FormField, type FormMapping,
} from "./form-flows.service";

const MIN_FILL_MS = 2000;

function parse<T>(raw: string | null, fb: T): T {
  if (!raw) return fb;
  try { return JSON.parse(raw) as T; } catch { return fb; }
}
function digits(s: string): string { return (s || "").replace(/\D/g, ""); }

// PUBLIC render payload — active public flows only, no sensitive internals.
export async function getPublicForm(token: string) {
  const flow = await prisma.formFlow.findFirst({
    where: { publicToken: token, status: "active", mode: "public" },
  });
  if (!flow) throw notFound("Form");
  return {
    id: flow.id,
    name: flow.name,
    steps: parse<FormStep[]>(flow.steps, []),
    theme: flow.theme ? parse(flow.theme, {}) : null,
    kioskMode: flow.kioskMode,
  };
}

// Load the full flow (companyId + mapping) for a submit context.
export async function loadPublicFlowForSubmit(token: string) {
  const flow = await prisma.formFlow.findFirst({
    where: { publicToken: token, status: "active", mode: "public" },
  });
  if (!flow) throw notFound("Form");
  return {
    companyId: flow.companyId,
    flow: { id: flow.id, name: flow.name, steps: parse<FormStep[]>(flow.steps, []), mapping: parse<FormMapping>(flow.mapping, {}) },
  };
}

export interface SubmitInput {
  data: Record<string, unknown>;
  honeypot?: string; // must be empty
  elapsedMs?: number; // time on the form
}

interface SubmitContext {
  companyId: string;
  flow: { id: string; name: string; steps: FormStep[]; mapping: FormMapping };
  source: "public" | "internal";
  submittedBy?: string | null;
}

// Field-level validation against the flow definition.
function validateAnswers(steps: FormStep[], data: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const step of steps) {
    for (const f of step.fields ?? []) {
      const raw = data[f.key];
      const empty = raw === undefined || raw === null || raw === "";
      if (f.required && empty) throw badRequest(`Missing required field: ${f.key}`);
      if (empty) continue;
      clean[f.key] = coerceField(f, raw);
    }
  }
  return clean;
}

function coerceField(f: FormField, raw: unknown): unknown {
  switch (f.type) {
    case "email": {
      const v = String(raw).trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw badRequest(`Invalid email: ${f.key}`);
      return v.toLowerCase();
    }
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw badRequest(`Invalid number: ${f.key}`);
      return n;
    }
    case "select": {
      const v = String(raw);
      if (f.options && !f.options.includes(v)) throw badRequest(`Invalid option for ${f.key}`);
      return v;
    }
    case "multi_select": {
      const arr = Array.isArray(raw) ? raw.map(String) : [String(raw)];
      if (f.options && arr.some((x) => !f.options!.includes(x))) throw badRequest(`Invalid option for ${f.key}`);
      return arr;
    }
    case "consent":
      return Boolean(raw);
    default:
      return String(raw).slice(0, 5000);
  }
}

// Dedupe upsert (email-insensitive OR phone last-9), same as lead ingest.
async function upsertContact(companyId: string, contact: Record<string, unknown>): Promise<string> {
  const email = typeof contact.email === "string" ? contact.email.toLowerCase() : null;
  const phone = typeof contact.phone === "string" ? contact.phone : null;
  const phoneDigits = phone ? digits(phone) : "";
  const or: Array<Record<string, unknown>> = [];
  if (email) or.push({ email: { equals: email, mode: "insensitive" } });
  if (phoneDigits.length >= 6) {
    or.push({ phone: { contains: phoneDigits.slice(-9) } });
    or.push({ whatsappPhone: { contains: phoneDigits.slice(-9) } });
  }
  if (or.length) {
    const existing = await prisma.customer.findFirst({ where: { companyId, OR: or as never }, select: { id: true } });
    if (existing) return existing.id;
  }
  const created = await prisma.customer.create({
    data: {
      companyId,
      fullName: (contact.fullName as string) || (email ?? phone ?? "New contact"),
      email,
      phone,
      companyName: (contact.companyName as string) ?? null,
      position: (contact.position as string) ?? null,
      country: (contact.country as string) ?? null,
      city: (contact.city as string) ?? null,
      address: (contact.address as string) ?? null,
      whatsappPhone: (contact.whatsappPhone as string) ?? null,
      notes: (contact.notes as string) ?? null,
      source: "form_submission",
      status: "new",
      customFields: contact.__custom ? (contact.__custom as never) : undefined,
    },
    select: { id: true },
  });
  return created.id;
}

export async function submitForm(ctx: SubmitContext, input: SubmitInput) {
  const { companyId, flow, source } = ctx;

  // Anti-spam: honeypot must be empty + the form must take a human moment.
  // Silent-drop (success-shaped) so bots don't learn the filter.
  const spam = !!(input.honeypot && String(input.honeypot).trim()) ||
    (typeof input.elapsedMs === "number" && input.elapsedMs < MIN_FILL_MS && source === "public");
  if (spam) {
    recordIntegrationEvent({ companyId, platform: "forms", eventType: "webhook_failed", errorCode: "SPAM_BLOCKED", requestContext: { flowId: flow.id } });
    return { ok: true, dropped: true, contactId: null, dealId: null };
  }

  const answers = validateAnswers(flow.steps, input.data ?? {});

  // Map ONLY whitelisted fields. customFields go under __custom.
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { country: true, baseCurrency: true } });
  const contactData: Record<string, unknown> = {};
  const custom: Record<string, unknown> = {};
  const cmap = flow.mapping.contact ?? {};
  for (const [fieldKey, target] of Object.entries(cmap)) {
    if (!(fieldKey in answers)) continue;
    if (target.startsWith("custom:")) { custom[target.slice(7)] = answers[fieldKey]; continue; }
    if (SENSITIVE_BLACKLIST.has(target) || !CONTACT_WRITABLE.has(target)) continue; // re-enforce whitelist
    if (target === "phone" || target === "whatsappPhone") {
      contactData[target] = normalizeE164(String(answers[fieldKey]), dialCodeForCountry(company?.country));
    } else {
      contactData[target] = answers[fieldKey];
    }
  }
  if (Object.keys(custom).length) contactData.__custom = custom;

  const contactId = await upsertContact(companyId, contactData);

  // Optional deal.
  let dealId: string | null = null;
  const cd = flow.mapping.createDeal;
  if (cd?.enabled) {
    const dmap = flow.mapping.deal ?? {};
    const dealData: Record<string, unknown> = {};
    for (const [fieldKey, target] of Object.entries(dmap)) {
      if (!(fieldKey in answers)) continue;
      if (SENSITIVE_BLACKLIST.has(target) || !DEAL_WRITABLE.has(target)) continue;
      dealData[target] = answers[fieldKey];
    }
    const deal = await prisma.deal.create({
      data: {
        companyId,
        customerId: contactId,
        title: (dealData.title as string) || cd.titleTemplate || `${flow.name} — ${contactData.fullName ?? "lead"}`,
        stage: cd.stage || "lead",
        value: typeof dealData.value === "number" ? (dealData.value as number) : 0,
        currency: (dealData.currency as string) || company?.baseCurrency || "USD",
        description: (dealData.description as string) ?? `From form: ${flow.name}`,
      },
      select: { id: true },
    });
    dealId = deal.id;
  }

  await prisma.formSubmission.create({
    data: {
      companyId, flowId: flow.id,
      data: JSON.stringify(answers),
      createdContactId: contactId,
      createdDealId: dealId,
      source,
      submittedBy: ctx.submittedBy ?? null,
    },
  });

  recordIntegrationEvent({ companyId, platform: "forms", eventType: "webhook_received", requestContext: { flowId: flow.id, contactId, dealId, source } });

  // Fire automation (form.submitted).
  const contact = await prisma.customer.findUnique({ where: { id: contactId }, select: { id: true, fullName: true, email: true, phone: true } });
  void dispatchFormSubmitted(companyId, contact!, dealId, { id: flow.id, name: flow.name });

  return { ok: true, dropped: false, contactId, dealId };
}
