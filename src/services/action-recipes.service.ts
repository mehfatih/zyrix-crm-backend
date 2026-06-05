// ============================================================================
// CUSTOM ACTIONS — action recipes (Sprint 13)
// ----------------------------------------------------------------------------
// No-code parameterized action recipes that plug into the Automation Engine as
// step type `recipe:{id}`. THREE types, NO arbitrary code execution (a security
// decision for multi-tenant SaaS):
//   • webhook_out       — signed (HMAC-SHA256) outbound POST, SSRF-guarded
//   • compute_field     — set a whitelisted field from a SAFE expression (expr-eval)
//   • conditional_update — if {field op value} then set {field}
//
// Expression safety: expr-eval has no loops, no member/function access to JS
// globals, no eval/require. On top of that we (1) reject raw forbidden tokens,
// (2) parse + restrict referenced variables to a known numeric scope.
// ============================================================================

import { createHmac } from "crypto";
import { Parser } from "expr-eval";
import { prisma } from "../config/database";
import { assertSafeWebhookUrl, SsrfError } from "../utils/ssrf";

export type RecipeType = "webhook_out" | "compute_field" | "conditional_update";

export interface ActionResult {
  ok: boolean;
  output?: unknown;
  error?: string;
}

// ── Writable target fields (compute_field / conditional_update) ───────────
// entity → field → coercion kind. customFields.<key> is always allowed.
const WRITABLE: Record<string, Record<string, "number" | "string">> = {
  deal: {
    value: "number",
    probability: "number",
    stage: "string",
    description: "string",
    lostReason: "string",
    currency: "string",
  },
  contact: {
    leadScore: "number",
    healthScore: "number",
    lifetimeValue: "number",
    status: "string",
    notes: "string",
    territory: "string",
  },
};
// contact is the same row as customer; accept both prefixes.
const ENTITY_ALIASES: Record<string, "deal" | "contact"> = {
  deal: "deal",
  contact: "contact",
  customer: "contact",
};

// ── Safe interpolation whitelist (webhook payloadTemplate {{...}}) ────────
const SAFE_TEMPLATE_FIELDS = new Set([
  "contact.id", "contact.fullName", "contact.email", "contact.phone",
  "contact.whatsappPhone", "contact.companyName", "contact.city",
  "contact.country", "contact.status",
  "deal.id", "deal.title", "deal.value", "deal.currency", "deal.stage",
  "event.type",
]);

// numeric scope variable names available to compute_field / conditional_update
const EXPR_SCOPE_FIELDS = [
  "deal_value", "deal_probability",
  "contact_leadScore", "contact_healthScore", "contact_lifetimeValue",
] as const;

const FORBIDDEN_EXPR = /\b(process|require|import|global|globalThis|eval|function|while|for|constructor|__proto__|prototype)\b|=>/i;

// ── Config shapes ─────────────────────────────────────────────────────────
export interface WebhookOutConfig {
  url: string;
  headers?: Record<string, string>;
  payloadTemplate?: string; // JSON string with {{whitelisted.path}}
  hmacSecret: string;
}
export interface ComputeFieldConfig {
  targetField: string; // "deal.value" | "contact.leadScore" | "deal.customFields.score"
  expression: string;
}
export interface ConditionalUpdateConfig {
  if: { field: string; op: string; value: unknown };
  then: { field: string; value: unknown };
}

const COND_OPS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "contains", "isEmpty", "isNotEmpty"]);

// ── Helpers ────────────────────────────────────────────────────────────────
function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, k) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[k];
    return undefined;
  }, obj);
}

function resolveEntity(target: string): { entity: "deal" | "contact"; field: string; isCustom: boolean } | null {
  const [rawEntity, ...rest] = target.split(".");
  const entity = ENTITY_ALIASES[rawEntity];
  if (!entity || rest.length === 0) return null;
  if (rest[0] === "customFields") {
    if (rest.length !== 2 || !rest[1]) return null;
    return { entity, field: rest[1], isCustom: true };
  }
  if (rest.length !== 1) return null;
  if (!WRITABLE[entity][rest[0]]) return null;
  return { entity, field: rest[0], isCustom: false };
}

function entityIdFromPayload(entity: "deal" | "contact", payload: any): string | null {
  if (entity === "deal") return payload?.deal?.id || payload?.dealId || null;
  return payload?.contact?.id || payload?.customer?.id || payload?.contactId || payload?.customerId || null;
}

function buildExprScope(payload: any): Record<string, number> {
  const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    deal_value: num(payload?.deal?.value),
    deal_probability: num(payload?.deal?.probability),
    contact_leadScore: num(payload?.contact?.leadScore ?? payload?.customer?.leadScore),
    contact_healthScore: num(payload?.contact?.healthScore ?? payload?.customer?.healthScore),
    contact_lifetimeValue: num(payload?.contact?.lifetimeValue ?? payload?.customer?.lifetimeValue),
  };
}

// Whitelisted interpolation — only SAFE_TEMPLATE_FIELDS resolve; everything
// else becomes empty string. customer.* is aliased to contact.*.
function safeInterpolate(template: string, payload: any): string {
  if (!template || !template.includes("{{")) return template;
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, rawPath) => {
    let path = String(rawPath).trim();
    if (path.startsWith("customer.")) path = "contact." + path.slice("customer.".length);
    if (!SAFE_TEMPLATE_FIELDS.has(path)) return "";
    const root = path.startsWith("contact.") ? { contact: payload?.contact ?? payload?.customer } : payload;
    const v = getPath(root, path);
    if (v === null || v === undefined) return "";
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

// ── Validation (save-time) ──────────────────────────────────────────────────
export function validateRecipeConfig(type: RecipeType, config: any): { ok: boolean; error?: string } {
  if (type === "webhook_out") {
    if (!config?.url || typeof config.url !== "string") return { ok: false, error: "url is required" };
    if (!config.url.startsWith("https://")) return { ok: false, error: "url must use https" };
    if (!config.hmacSecret || typeof config.hmacSecret !== "string" || config.hmacSecret.length < 8)
      return { ok: false, error: "hmacSecret (≥8 chars) is required" };
    if (config.headers && typeof config.headers === "object") {
      for (const k of Object.keys(config.headers)) {
        if (/^(host|content-length|authorization)$/i.test(k))
          return { ok: false, error: `header "${k}" is not allowed` };
      }
    }
    if (config.payloadTemplate && typeof config.payloadTemplate !== "string")
      return { ok: false, error: "payloadTemplate must be a string" };
    return { ok: true };
  }
  if (type === "compute_field") {
    const r = resolveEntity(String(config?.targetField ?? ""));
    if (!r) return { ok: false, error: "targetField is not a writable field" };
    const expr = String(config?.expression ?? "");
    if (!expr.trim()) return { ok: false, error: "expression is required" };
    if (FORBIDDEN_EXPR.test(expr)) return { ok: false, error: "expression contains a forbidden token" };
    try {
      const parsed = new Parser().parse(expr);
      const used = parsed.variables();
      const allowed = new Set<string>(EXPR_SCOPE_FIELDS as readonly string[]);
      const bad = used.filter((v) => !allowed.has(v));
      if (bad.length) return { ok: false, error: `unknown variable(s): ${bad.join(", ")}` };
    } catch (e: any) {
      return { ok: false, error: `invalid expression: ${e?.message || "parse error"}` };
    }
    return { ok: true };
  }
  if (type === "conditional_update") {
    if (!config?.if?.field || !COND_OPS.has(String(config?.if?.op)))
      return { ok: false, error: "invalid condition" };
    const r = resolveEntity(String(config?.then?.field ?? ""));
    if (!r) return { ok: false, error: "then.field is not a writable field" };
    return { ok: true };
  }
  return { ok: false, error: `unknown recipe type: ${type}` };
}

// ── Field write ─────────────────────────────────────────────────────────────
function coerce(kind: "number" | "string", raw: unknown): number | string {
  if (kind === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  return String(raw ?? "");
}

async function writeField(
  companyId: string,
  entity: "deal" | "contact",
  id: string,
  field: string,
  isCustom: boolean,
  value: unknown,
  dryRun: boolean
): Promise<{ entity: string; id: string; field: string; value: unknown }> {
  const out = { entity, id, field: isCustom ? `customFields.${field}` : field, value };
  if (dryRun) return out;

  if (isCustom) {
    if (entity === "deal") {
      const row = await prisma.deal.findFirst({ where: { id, companyId }, select: { customFields: true } });
      const cf = { ...((row?.customFields as object) ?? {}), [field]: value };
      await prisma.deal.update({ where: { id }, data: { customFields: cf as any } });
    } else {
      const row = await prisma.customer.findFirst({ where: { id, companyId }, select: { customFields: true } });
      const cf = { ...((row?.customFields as object) ?? {}), [field]: value };
      await prisma.customer.update({ where: { id }, data: { customFields: cf as any } });
    }
    return out;
  }

  const kind = WRITABLE[entity][field];
  const coerced = coerce(kind, value);
  if (entity === "deal") {
    await prisma.deal.updateMany({ where: { id, companyId }, data: { [field]: coerced } as any });
  } else {
    await prisma.customer.updateMany({ where: { id, companyId }, data: { [field]: coerced } as any });
  }
  return { ...out, value: coerced };
}

// ── Condition eval ───────────────────────────────────────────────────────────
function evalCondition(cond: { field: string; op: string; value: unknown }, payload: any): boolean {
  let path = cond.field;
  if (path.startsWith("customer.")) path = "contact." + path.slice("customer.".length);
  const root = path.startsWith("contact.") ? { contact: payload?.contact ?? payload?.customer } : payload;
  const actual = getPath(root, path);
  const exp = cond.value;
  switch (cond.op) {
    case "eq": return String(actual) === String(exp);
    case "neq": return String(actual) !== String(exp);
    case "gt": return Number(actual) > Number(exp);
    case "gte": return Number(actual) >= Number(exp);
    case "lt": return Number(actual) < Number(exp);
    case "lte": return Number(actual) <= Number(exp);
    case "contains": return String(actual ?? "").toLowerCase().includes(String(exp ?? "").toLowerCase());
    case "isEmpty": return actual === null || actual === undefined || String(actual).trim() === "";
    case "isNotEmpty": return !(actual === null || actual === undefined || String(actual).trim() === "");
    default: return false;
  }
}

// ── Execution ─────────────────────────────────────────────────────────────────
export async function executeRecipeConfig(
  companyId: string,
  type: RecipeType,
  config: any,
  payload: any,
  opts: { dryRun?: boolean } = {}
): Promise<ActionResult> {
  const dryRun = opts.dryRun === true;
  try {
    if (type === "webhook_out") {
      const body = safeInterpolate(String(config.payloadTemplate ?? "{}"), payload);
      const signature = createHmac("sha256", String(config.hmacSecret)).update(body).digest("hex");
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Zyrix-Signature": `sha256=${signature}`,
      };
      if (config.headers && typeof config.headers === "object") {
        for (const [k, v] of Object.entries(config.headers)) {
          if (!/^(host|content-length|authorization)$/i.test(k)) headers[k] = String(v);
        }
      }
      if (dryRun) {
        // Validate URL (SSRF) but DO NOT send unless it's an explicit webhook test.
        await assertSafeWebhookUrl(String(config.url));
        return { ok: true, output: { resolvedBody: body, headers, signature, sent: false } };
      }
      await assertSafeWebhookUrl(String(config.url));
      const MAX_TRIES = 3;
      let lastError = "unknown error";
      for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10_000);
        try {
          const resp = await fetch(String(config.url), {
            method: "POST",
            headers: { ...headers, "X-Zyrix-Delivery-Attempt": String(attempt) },
            body,
            signal: controller.signal,
          });
          const text = await resp.text();
          if (resp.ok) return { ok: true, output: { status: resp.status, attempt, responseSnippet: text.slice(0, 500) } };
          lastError = `HTTP ${resp.status}: ${text.slice(0, 200)}`;
        } catch (e: any) {
          lastError = e?.name === "AbortError" ? "timed out after 10s" : e?.message || "request failed";
        } finally {
          clearTimeout(timeoutId);
        }
        if (attempt < MAX_TRIES) await new Promise((r) => setTimeout(r, attempt * 500));
      }
      return { ok: false, error: `webhook_out failed after ${MAX_TRIES} attempts: ${lastError}` };
    }

    if (type === "compute_field") {
      const r = resolveEntity(String(config.targetField));
      if (!r) return { ok: false, error: "targetField is not writable" };
      const scope = buildExprScope(payload);
      let result: number;
      try {
        result = new Parser().parse(String(config.expression)).evaluate(scope);
      } catch (e: any) {
        return { ok: false, error: `expression failed: ${e?.message || "eval error"}` };
      }
      const id = entityIdFromPayload(r.entity, payload);
      if (!id) return dryRun
        ? { ok: true, output: { computed: result, note: `no ${r.entity} id in sample` } }
        : { ok: false, error: `no ${r.entity} id in payload` };
      const written = await writeField(companyId, r.entity, id, r.field, r.isCustom, result, dryRun);
      return { ok: true, output: { computed: result, written } };
    }

    if (type === "conditional_update") {
      const matched = evalCondition(config.if, payload);
      if (!matched) return { ok: true, output: { matched: false, note: "condition not met — no change" } };
      const r = resolveEntity(String(config.then.field));
      if (!r) return { ok: false, error: "then.field is not writable" };
      const id = entityIdFromPayload(r.entity, payload);
      if (!id) return dryRun
        ? { ok: true, output: { matched: true, note: `no ${r.entity} id in sample` } }
        : { ok: false, error: `no ${r.entity} id in payload` };
      const written = await writeField(companyId, r.entity, id, r.field, r.isCustom, config.then.value, dryRun);
      return { ok: true, output: { matched: true, written } };
    }

    return { ok: false, error: `unknown recipe type: ${type}` };
  } catch (e: any) {
    if (e instanceof SsrfError) return { ok: false, error: `blocked: ${e.message}` };
    return { ok: false, error: e?.message || "recipe execution failed" };
  }
}

// ── CRUD ─────────────────────────────────────────────────────────────────────
export interface RecipeRow {
  id: string;
  companyId: string;
  name: string;
  type: string;
  config: any;
  enabled: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function parseRow(r: any): RecipeRow {
  let config: any = {};
  try { config = JSON.parse(r.config); } catch { config = {}; }
  return { ...r, config };
}

export async function listRecipes(companyId: string): Promise<RecipeRow[]> {
  const rows = await prisma.actionRecipe.findMany({ where: { companyId }, orderBy: { createdAt: "desc" } });
  return rows.map(parseRow);
}

export async function getRecipe(companyId: string, id: string): Promise<RecipeRow | null> {
  const r = await prisma.actionRecipe.findFirst({ where: { id, companyId } });
  return r ? parseRow(r) : null;
}

export async function createRecipe(
  companyId: string,
  userId: string,
  input: { name: string; type: RecipeType; config: any; enabled?: boolean }
): Promise<RecipeRow> {
  const v = validateRecipeConfig(input.type, input.config);
  if (!v.ok) throw Object.assign(new Error(v.error), { statusCode: 422, code: "INVALID_RECIPE" });
  const r = await prisma.actionRecipe.create({
    data: {
      companyId,
      name: input.name.trim().slice(0, 120) || "Untitled action",
      type: input.type,
      config: JSON.stringify(input.config ?? {}),
      enabled: input.enabled !== false,
      createdBy: userId,
    },
  });
  return parseRow(r);
}

export async function updateRecipe(
  companyId: string,
  id: string,
  input: { name?: string; config?: any; enabled?: boolean }
): Promise<RecipeRow> {
  const existing = await prisma.actionRecipe.findFirst({ where: { id, companyId } });
  if (!existing) throw Object.assign(new Error("Recipe not found"), { statusCode: 404 });
  if (input.config !== undefined) {
    const v = validateRecipeConfig(existing.type as RecipeType, input.config);
    if (!v.ok) throw Object.assign(new Error(v.error), { statusCode: 422, code: "INVALID_RECIPE" });
  }
  const r = await prisma.actionRecipe.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim().slice(0, 120) } : {}),
      ...(input.config !== undefined ? { config: JSON.stringify(input.config) } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    },
  });
  return parseRow(r);
}

export async function deleteRecipe(companyId: string, id: string): Promise<void> {
  await prisma.actionRecipe.deleteMany({ where: { id, companyId } });
}
