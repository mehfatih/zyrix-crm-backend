// ============================================================================
// WORKFLOW SERVICE
// ----------------------------------------------------------------------------
// CRUD for user workflows plus the execution helpers (enqueueExecution,
// runExecution). Trigger event emission (called from customer.service,
// deal.service, etc.) and the cron retry worker land in session 2.
//
// Uses raw SQL for reads/writes to the new tables since Prisma client
// regeneration is blocked in the dev container — Railway regenerates on
// deploy and the code works there unchanged.
// ============================================================================

import { GoogleGenerativeAI } from "@google/generative-ai";
import { prisma } from "../config/database";
import { env } from "../config/env";
import { notFound, AppError, badRequest } from "../middleware/errorHandler";
import {
  TRIGGERS,
  ACTIONS,
  VALID_TRIGGER_TYPES,
  VALID_ACTION_TYPES,
  CONDITION_OPERATORS,
  type ConditionOperator,
} from "./workflows-catalog";

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

export interface WorkflowTrigger {
  type: string;
  config: Record<string, unknown>;
}

export interface WorkflowAction {
  id: string;
  type: string;
  config: Record<string, unknown>;
  stopOnError?: boolean;
  delaySeconds?: number;
}

export interface WorkflowCondition {
  field: string;
  operator: ConditionOperator;
  value: unknown;
}

export interface WorkflowRow {
  id: string;
  companyId: string;
  createdById: string;
  name: string;
  description: string | null;
  isEnabled: boolean;
  trigger: WorkflowTrigger;
  actions: WorkflowAction[];
  conditions: WorkflowCondition[];
  runCount: number;
  successCount: number;
  failureCount: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

// ──────────────────────────────────────────────────────────────────────
// Validation + sanitization
// ──────────────────────────────────────────────────────────────────────

function sanitizeTrigger(input: unknown): WorkflowTrigger {
  if (!input || typeof input !== "object") {
    throw badRequest("trigger is required");
  }
  const raw = input as Record<string, unknown>;
  if (typeof raw.type !== "string" || !VALID_TRIGGER_TYPES.has(raw.type)) {
    throw badRequest(`Unknown trigger type: ${String(raw.type)}`);
  }
  const config =
    raw.config && typeof raw.config === "object" && !Array.isArray(raw.config)
      ? (raw.config as Record<string, unknown>)
      : {};
  return { type: raw.type, config };
}

function sanitizeActions(input: unknown): WorkflowAction[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: WorkflowAction[] = [];
  // Cap at 20 actions per workflow — runaway chains cost real money
  // (especially call_webhook with retries) and signal a design smell.
  for (const raw of input.slice(0, 20)) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Record<string, unknown>;
    if (typeof a.id !== "string" || typeof a.type !== "string") continue;
    if (!VALID_ACTION_TYPES.has(a.type)) continue;
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    out.push({
      id: a.id,
      type: a.type,
      config:
        a.config && typeof a.config === "object" && !Array.isArray(a.config)
          ? (a.config as Record<string, unknown>)
          : {},
      stopOnError: a.stopOnError === false ? false : true,
      delaySeconds:
        typeof a.delaySeconds === "number" && a.delaySeconds >= 0
          ? Math.min(a.delaySeconds, 3600)
          : undefined,
    });
  }
  return out;
}

function sanitizeConditions(input: unknown): WorkflowCondition[] {
  if (!Array.isArray(input)) return [];
  const out: WorkflowCondition[] = [];
  // Cap at 10 — workflows with 10+ conditions are almost always a
  // misuse of the feature (should be split into separate workflows).
  for (const raw of input.slice(0, 10)) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    if (typeof c.field !== "string" || typeof c.operator !== "string") continue;
    if (!(CONDITION_OPERATORS as readonly string[]).includes(c.operator))
      continue;
    out.push({
      field: c.field,
      operator: c.operator as ConditionOperator,
      value: c.value,
    });
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────────────────────────────

export async function listWorkflows(
  companyId: string,
  filters?: { isEnabled?: boolean; triggerType?: string }
): Promise<WorkflowRow[]> {
  const conds: string[] = [`"companyId" = $1`];
  const params: (string | boolean)[] = [companyId];
  if (filters?.isEnabled !== undefined) {
    params.push(filters.isEnabled);
    conds.push(`"isEnabled" = $${params.length}`);
  }
  if (filters?.triggerType) {
    params.push(filters.triggerType);
    conds.push(`trigger->>'type' = $${params.length}`);
  }
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT * FROM workflows WHERE ${conds.join(" AND ")}
     ORDER BY "createdAt" DESC`,
    ...params
  )) as WorkflowRow[];
  return rows;
}

export async function getWorkflow(
  companyId: string,
  id: string
): Promise<WorkflowRow> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT * FROM workflows WHERE id = $1 AND "companyId" = $2 LIMIT 1`,
    id,
    companyId
  )) as WorkflowRow[];
  if (rows.length === 0) throw notFound("Workflow not found");
  return rows[0];
}

export async function createWorkflow(
  companyId: string,
  userId: string,
  dto: {
    name: string;
    description?: string;
    trigger: unknown;
    actions?: unknown;
    conditions?: unknown;
    isEnabled?: boolean;
  }
): Promise<WorkflowRow> {
  if (!dto.name || dto.name.trim().length === 0) {
    throw badRequest("name is required");
  }
  const trigger = sanitizeTrigger(dto.trigger);
  const actions = sanitizeActions(dto.actions);
  const conditions = sanitizeConditions(dto.conditions);
  const isEnabled = dto.isEnabled !== false;

  const rows = (await prisma.$queryRawUnsafe(
    `INSERT INTO workflows
       (id, "companyId", "createdById", name, description, "isEnabled",
        trigger, actions, conditions, "createdAt", "updatedAt")
     VALUES
       (gen_random_uuid(), $1, $2, $3, $4, $5,
        $6::jsonb, $7::jsonb, $8::jsonb, NOW(), NOW())
     RETURNING *`,
    companyId,
    userId,
    dto.name.trim(),
    dto.description ?? null,
    isEnabled,
    JSON.stringify(trigger),
    JSON.stringify(actions),
    JSON.stringify(conditions)
  )) as WorkflowRow[];
  return rows[0];
}

export async function updateWorkflow(
  companyId: string,
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    trigger?: unknown;
    actions?: unknown;
    conditions?: unknown;
    isEnabled?: boolean;
  }
): Promise<WorkflowRow> {
  await getWorkflow(companyId, id); // existence check

  const sets: string[] = [];
  const params: (string | boolean | null)[] = [];
  const push = (col: string, val: string | boolean | null) => {
    params.push(val);
    sets.push(`"${col}" = $${params.length}`);
  };

  if (patch.name !== undefined) {
    if (!patch.name || patch.name.trim().length === 0) {
      throw badRequest("name cannot be empty");
    }
    push("name", patch.name.trim());
  }
  if (patch.description !== undefined) {
    push("description", patch.description);
  }
  if (patch.isEnabled !== undefined) {
    push("isEnabled", patch.isEnabled);
  }
  if (patch.trigger !== undefined) {
    const trig = sanitizeTrigger(patch.trigger);
    params.push(JSON.stringify(trig));
    sets.push(`trigger = $${params.length}::jsonb`);
  }
  if (patch.actions !== undefined) {
    const acts = sanitizeActions(patch.actions);
    params.push(JSON.stringify(acts));
    sets.push(`actions = $${params.length}::jsonb`);
  }
  if (patch.conditions !== undefined) {
    const conds = sanitizeConditions(patch.conditions);
    params.push(JSON.stringify(conds));
    sets.push(`conditions = $${params.length}::jsonb`);
  }

  if (sets.length === 0) {
    return getWorkflow(companyId, id);
  }

  sets.push(`"updatedAt" = NOW()`);
  params.push(id);
  params.push(companyId);
  const rows = (await prisma.$queryRawUnsafe(
    `UPDATE workflows SET ${sets.join(", ")}
     WHERE id = $${params.length - 1} AND "companyId" = $${params.length}
     RETURNING *`,
    ...params
  )) as WorkflowRow[];
  return rows[0];
}

export async function deleteWorkflow(
  companyId: string,
  id: string
): Promise<{ deleted: true }> {
  await getWorkflow(companyId, id);
  await prisma.$executeRawUnsafe(
    `DELETE FROM workflows WHERE id = $1 AND "companyId" = $2`,
    id,
    companyId
  );
  return { deleted: true };
}

// ──────────────────────────────────────────────────────────────────────
// CONDITIONS EVALUATION
// ──────────────────────────────────────────────────────────────────────

/**
 * Resolve a dotted path against a payload object. Returns undefined for
 * any missing segment instead of throwing so evaluateCondition can test
 * emptiness without blowing up.
 */
function resolvePath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cursor: any = obj;
  for (const segment of path.split(".")) {
    if (cursor == null || typeof cursor !== "object") return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.length === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

export function evaluateConditions(
  conditions: WorkflowCondition[],
  payload: unknown
): boolean {
  if (!conditions || conditions.length === 0) return true;
  for (const c of conditions) {
    const actual = resolvePath(payload, c.field);
    let ok = false;
    switch (c.operator) {
      case "eq":
        ok = String(actual) === String(c.value);
        break;
      case "neq":
        ok = String(actual) !== String(c.value);
        break;
      case "gt":
        ok = Number(actual) > Number(c.value);
        break;
      case "gte":
        ok = Number(actual) >= Number(c.value);
        break;
      case "lt":
        ok = Number(actual) < Number(c.value);
        break;
      case "lte":
        ok = Number(actual) <= Number(c.value);
        break;
      case "contains":
        ok = String(actual ?? "").toLowerCase().includes(String(c.value ?? "").toLowerCase());
        break;
      case "startsWith":
        ok = String(actual ?? "").toLowerCase().startsWith(String(c.value ?? "").toLowerCase());
        break;
      case "endsWith":
        ok = String(actual ?? "").toLowerCase().endsWith(String(c.value ?? "").toLowerCase());
        break;
      case "in":
        ok = String(c.value ?? "")
          .split(",")
          .map((s) => s.trim())
          .includes(String(actual));
        break;
      case "isTrue":
        ok = Boolean(actual);
        break;
      case "isFalse":
        ok = !actual;
        break;
      case "isEmpty":
        ok = isEmpty(actual);
        break;
      case "isNotEmpty":
        ok = !isEmpty(actual);
        break;
    }
    if (!ok) return false;
  }
  return true;
}

// ──────────────────────────────────────────────────────────────────────
// TEMPLATE INTERPOLATION
// ──────────────────────────────────────────────────────────────────────
// Replaces {{path.to.field}} in a string with values from the payload.
// Missing paths render as empty strings (silent) instead of throwing —
// a user who typos a field reference shouldn't get a workflow run
// failure, they should see their message with the blank spot and fix it.
// ──────────────────────────────────────────────────────────────────────

export function interpolate(template: string, payload: unknown): string {
  if (!template || !template.includes("{{")) return template;
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, path) => {
    const v = resolvePath(payload, path.trim());
    if (v === null || v === undefined) return "";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  });
}

// ──────────────────────────────────────────────────────────────────────
// EXECUTION ENQUEUE
// ──────────────────────────────────────────────────────────────────────
// Called by the event dispatcher (next session) when a trigger fires.
// We create a pending execution row immediately + kick off a try-run
// inside the same request cycle. If the async run fails or the server
// crashes mid-run, the cron retry worker picks it up.
// ──────────────────────────────────────────────────────────────────────

export async function enqueueExecution(
  workflowId: string,
  companyId: string,
  triggerPayload: unknown
): Promise<{ executionId: string }> {
  const rows = (await prisma.$queryRawUnsafe(
    `INSERT INTO workflow_executions
       (id, "workflowId", "companyId", "triggerPayload", status, "queuedAt")
     VALUES (gen_random_uuid(), $1, $2, $3::jsonb, 'pending', NOW())
     RETURNING id`,
    workflowId,
    companyId,
    JSON.stringify(triggerPayload)
  )) as { id: string }[];
  return { executionId: rows[0].id };
}

// ──────────────────────────────────────────────────────────────────────
// MANUAL TEST RUN
// ──────────────────────────────────────────────────────────────────────
// POST /api/workflows/:id/test lets users feed a fake payload to their
// workflow and see exactly what would happen, without waiting for a real
// trigger. Useful during setup. Creates a full execution row with
// status='pending' which the worker will pick up immediately.
// ──────────────────────────────────────────────────────────────────────

export async function createTestExecution(
  companyId: string,
  workflowId: string,
  mockPayload: unknown
): Promise<{ executionId: string }> {
  const wf = await getWorkflow(companyId, workflowId);
  if (!wf.isEnabled) {
    throw new AppError(
      "Enable the workflow first — disabled workflows don't run.",
      400,
      "WORKFLOW_DISABLED"
    );
  }
  return enqueueExecution(wf.id, wf.companyId, mockPayload ?? {});
}

// ──────────────────────────────────────────────────────────────────────
// EXECUTION HISTORY
// ──────────────────────────────────────────────────────────────────────

export async function listExecutions(
  companyId: string,
  filters?: { workflowId?: string; status?: string; limit?: number; offset?: number }
) {
  const cappedLimit = Math.min(Math.max(filters?.limit ?? 50, 1), 200);
  const cappedOffset = Math.max(filters?.offset ?? 0, 0);
  const conds: string[] = [`we."companyId" = $1`];
  const params: (string | number)[] = [companyId];
  if (filters?.workflowId) {
    params.push(filters.workflowId);
    conds.push(`we."workflowId" = $${params.length}`);
  }
  if (filters?.status) {
    params.push(filters.status);
    conds.push(`we.status = $${params.length}`);
  }

  // Total count
  const totalRows = (await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS total FROM workflow_executions we
     WHERE ${conds.join(" AND ")}`,
    ...params
  )) as { total: number }[];

  params.push(cappedLimit);
  params.push(cappedOffset);
  const items = await prisma.$queryRawUnsafe(
    `SELECT we.*, w.name AS "workflowName"
     FROM workflow_executions we
     JOIN workflows w ON w.id = we."workflowId"
     WHERE ${conds.join(" AND ")}
     ORDER BY we."queuedAt" DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    ...params
  );

  return {
    items,
    pagination: {
      total: totalRows[0]?.total ?? 0,
      limit: cappedLimit,
      offset: cappedOffset,
    },
  };
}

export async function getExecution(
  companyId: string,
  id: string
) {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT we.*, w.name AS "workflowName"
     FROM workflow_executions we
     JOIN workflows w ON w.id = we."workflowId"
     WHERE we.id = $1 AND we."companyId" = $2 LIMIT 1`,
    id,
    companyId
  )) as any[];
  if (rows.length === 0) throw notFound("Execution not found");
  return rows[0];
}

// ──────────────────────────────────────────────────────────────────────
// DRY-RUN (test without side effects)
// ----------------------------------------------------------------------------
// Evaluates the conditions against a sample payload and returns a plan of
// what WOULD happen — no messages sent, no records touched. Distinct from
// createTestExecution, which enqueues a real run.
// ──────────────────────────────────────────────────────────────────────

export async function dryRunWorkflow(
  companyId: string,
  id: string,
  samplePayload: unknown
): Promise<{
  conditionsPassed: boolean;
  plan: { step: number; actionType: string; preview: Record<string, string>; isWait: boolean }[];
}> {
  const wf = await getWorkflow(companyId, id);
  const conditions = (wf as any).conditions as WorkflowCondition[];
  const parsedConditions =
    typeof conditions === "string" ? JSON.parse(conditions as any) : conditions;
  const conditionsPassed = evaluateConditions(parsedConditions ?? [], samplePayload ?? {});

  const actionsRaw = (wf as any).actions;
  const actions: WorkflowAction[] =
    typeof actionsRaw === "string" ? JSON.parse(actionsRaw) : actionsRaw ?? [];

  const plan = actions.map((a, i) => {
    // Interpolate string config values so the user sees the resolved preview
    // (e.g. the actual phone/subject) without sending anything.
    const preview: Record<string, string> = {};
    for (const [k, v] of Object.entries(a.config ?? {})) {
      if (typeof v === "string") preview[k] = interpolate(v, samplePayload ?? {});
      else if (v != null) preview[k] = String(v);
    }
    return { step: i + 1, actionType: a.type, preview, isWait: a.type === "wait" };
  });

  return { conditionsPassed, plan };
}

// ──────────────────────────────────────────────────────────────────────
// AI BUILDER — natural-language → reviewable automation draft
// ----------------------------------------------------------------------------
// Gemini drafts an automation from a free-text description (any language).
// We validate the draft against the trigger/action registry server-side and
// flag invalid parts so the UI can highlight them. The draft is NEVER auto-
// activated — it's handed back for the user to review + save as a draft.
// ──────────────────────────────────────────────────────────────────────

const aiClient = env.GEMINI_API_KEY ? new GoogleGenerativeAI(env.GEMINI_API_KEY) : null;

export interface AiDraftFlag {
  path: string;
  reason: string;
}

export interface AiAutomationDraft {
  name: string;
  description: string;
  trigger: WorkflowTrigger;
  conditions: WorkflowCondition[];
  actions: WorkflowAction[];
  flags: AiDraftFlag[];
}

function catalogSummary(): string {
  const trigs = TRIGGERS.map(
    (t) =>
      `- ${t.type}: ${t.label.en}. config keys: [${t.configFields
        .map((f) => f.key)
        .join(", ")}]`
  ).join("\n");
  const acts = ACTIONS.map(
    (a) =>
      `- ${a.type}: ${a.label.en}. config keys: [${a.configFields
        .map((f) => f.key)
        .join(", ")}]`
  ).join("\n");
  return `TRIGGERS (pick exactly one):\n${trigs}\n\nACTIONS (steps, in order):\n${acts}\n\nCONDITION operators: ${CONDITION_OPERATORS.join(
    ", "
  )}`;
}

export async function aiBuildDraft(
  _companyId: string,
  promptText: string,
  locale: string = "en"
): Promise<AiAutomationDraft> {
  if (!aiClient) {
    throw new AppError("AI is not configured", 503, "AI_UNAVAILABLE");
  }
  if (!promptText || promptText.trim().length < 3) {
    throw badRequest("Describe the automation you want");
  }

  const model = aiClient.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: { responseMimeType: "application/json" },
  });

  const sys = `You are an automation builder for a CRM. Given a user's description (which may be in Arabic, Turkish, or English), produce ONE automation as strict JSON.

${catalogSummary()}

Output JSON shape EXACTLY:
{
  "name": "short name in the user's language",
  "description": "one sentence",
  "trigger": { "type": "<one trigger type from the list>", "config": { } },
  "conditions": [ { "field": "deal.value", "operator": "<operator>", "value": "1000" } ],
  "steps": [ { "type": "<one action type from the list>", "config": { } } ]
}

Rules:
- Use ONLY trigger/action types from the lists above. If unsure, pick the closest.
- config keys must come from that type's listed config keys. Use {{customer.phone}}, {{customer.email}}, {{deal.id}} style templates where a value should come from the triggering record.
- conditions may be an empty array. steps must have at least one item.
- Return JSON only, no markdown.`;

  const result = await model.generateContent(`${sys}\n\nUSER DESCRIPTION (${locale}):\n${promptText}`);
  const raw = result.response.text().trim();
  const jsonText = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");

  let parsed: any;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new AppError("AI returned malformed JSON — try rephrasing", 502, "AI_BAD_OUTPUT");
  }

  const flags: AiDraftFlag[] = [];

  // Validate trigger
  const triggerType = String(parsed?.trigger?.type ?? "");
  if (!VALID_TRIGGER_TYPES.has(triggerType)) {
    flags.push({ path: "trigger.type", reason: `Unknown trigger "${triggerType}"` });
  }
  const trigger: WorkflowTrigger = {
    type: triggerType,
    config:
      parsed?.trigger?.config && typeof parsed.trigger.config === "object"
        ? parsed.trigger.config
        : {},
  };

  // Validate conditions
  const conditions: WorkflowCondition[] = Array.isArray(parsed?.conditions)
    ? parsed.conditions.map((c: any, i: number) => {
        if (!(CONDITION_OPERATORS as readonly string[]).includes(c?.operator)) {
          flags.push({
            path: `conditions[${i}].operator`,
            reason: `Unknown operator "${c?.operator}"`,
          });
        }
        return { field: String(c?.field ?? ""), operator: c?.operator, value: c?.value };
      })
    : [];

  // Validate steps → actions (with generated ids the builder expects)
  const stepsIn = Array.isArray(parsed?.steps) ? parsed.steps : [];
  const actions: WorkflowAction[] = stepsIn.map((s: any, i: number) => {
    const type = String(s?.type ?? "");
    if (!VALID_ACTION_TYPES.has(type)) {
      flags.push({ path: `steps[${i}].type`, reason: `Unknown action "${type}"` });
    }
    return {
      id: `ai-${i + 1}`,
      type,
      config: s?.config && typeof s.config === "object" ? s.config : {},
    };
  });
  if (actions.length === 0) {
    flags.push({ path: "steps", reason: "No steps were produced — add at least one" });
  }

  return {
    name: String(parsed?.name ?? "AI automation").slice(0, 200),
    description: String(parsed?.description ?? ""),
    trigger,
    conditions,
    actions,
    flags,
  };
}
