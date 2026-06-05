// ============================================================================
// JOURNEY SERVICE — Sprint 11
// ----------------------------------------------------------------------------
// A journey is a visual multi-channel canvas (nodes + edges) that COMPILES into
// the same engine as everything else: kind='journey' workflow with a real
// trigger + a linear action array where `branch` actions jump forward
// (trueGoto) to implement the canvas's branches. The existing dispatcher runs
// it on its trigger — no separate executor. Branch evaluation supports
// behavioral conditions (opened/clicked within N days) via a DB lookup.
// ============================================================================

import { prisma } from "../config/database";
import { AppError, badRequest, notFound } from "../middleware/errorHandler";

export interface JourneyNode {
  id: string;
  type: "trigger" | "message" | "wait" | "branch" | "assign" | "tag" | "end";
  x: number;
  y: number;
  config: Record<string, any>;
}
export interface JourneyEdge {
  from: string;
  to: string;
  label?: string; // for branch: "true"/"yes" vs "false"/"no"
}
export interface Canvas {
  nodes: JourneyNode[];
  edges: JourneyEdge[];
}

function parseCanvas(raw: string | null): Canvas {
  if (!raw) return { nodes: [], edges: [] };
  try {
    const c = JSON.parse(raw);
    return { nodes: Array.isArray(c.nodes) ? c.nodes : [], edges: Array.isArray(c.edges) ? c.edges : [] };
  } catch {
    return { nodes: [], edges: [] };
  }
}

// ── Validation (powers the editor's pre-activation banner) ───────────────────
export interface JourneyIssue {
  level: "error" | "warning";
  code: string;
  nodeId?: string;
  message: string;
}
export function validateCanvas(canvas: Canvas): JourneyIssue[] {
  const issues: JourneyIssue[] = [];
  const triggers = canvas.nodes.filter((n) => n.type === "trigger");
  if (triggers.length !== 1) {
    issues.push({ level: "error", code: "TRIGGER", message: "A journey needs exactly one trigger node" });
  }
  // Missing WhatsApp template.
  for (const n of canvas.nodes) {
    if (n.type === "message" && n.config?.channel === "whatsapp" && !n.config?.templateName) {
      issues.push({ level: "error", code: "WHATSAPP_TEMPLATE_REQUIRED", nodeId: n.id, message: "WhatsApp node needs an approved template" });
    }
  }
  // Unreachable nodes (not reachable from the trigger).
  if (triggers.length === 1) {
    const adj = new Map<string, string[]>();
    for (const e of canvas.edges) adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
    const seen = new Set<string>();
    const stack = [triggers[0].id];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const t of adj.get(id) ?? []) stack.push(t);
    }
    for (const n of canvas.nodes) {
      if (!seen.has(n.id)) issues.push({ level: "warning", code: "UNREACHABLE", nodeId: n.id, message: `Node "${n.type}" is unreachable` });
    }
  }
  return issues;
}

interface CompiledAction { id: string; type: string; config: Record<string, unknown>; stopOnError: boolean }

// Canvas (tree from the trigger) → engine trigger + linear action array with
// forward branch jumps. Shared/merged nodes terminate the second path (v1).
export function compileCanvas(canvas: Canvas): { trigger: { type: string; config: Record<string, unknown> }; actions: CompiledAction[] } {
  const byId = new Map(canvas.nodes.map((n) => [n.id, n]));
  const outEdges = new Map<string, JourneyEdge[]>();
  for (const e of canvas.edges) outEdges.set(e.from, [...(outEdges.get(e.from) ?? []), e]);

  const trigger = canvas.nodes.find((n) => n.type === "trigger");
  const triggerSpec = trigger
    ? { type: String(trigger.config?.triggerType ?? "manual"), config: (trigger.config?.config as Record<string, unknown>) ?? {} }
    : { type: "manual", config: {} };

  const actions: CompiledAction[] = [];
  const visited = new Set<string>();

  const pushEnd = () => actions.push({ id: `end-${actions.length}`, type: "end", config: {}, stopOnError: false });

  function nextOf(id: string): string | null {
    const outs = outEdges.get(id) ?? [];
    return outs[0]?.to ?? null;
  }

  function emit(nodeId: string | null): void {
    if (!nodeId) { pushEnd(); return; }
    const node = byId.get(nodeId);
    if (!node || node.type === "end" || visited.has(nodeId)) { pushEnd(); return; }
    visited.add(nodeId);

    if (node.type === "message") {
      const ch = node.config?.channel;
      if (ch === "email") {
        actions.push({ id: node.id, type: "send_email", config: { toEmail: "{{contact.email}}", subject: node.config?.subject ?? "", body: node.config?.body ?? "" }, stopOnError: false });
      } else if (ch === "whatsapp") {
        actions.push({ id: node.id, type: "send_whatsapp_template", config: { toPhone: "{{contact.phone}}", templateName: node.config?.templateName ?? "", templateLang: node.config?.templateLang ?? "en" }, stopOnError: false });
      } else {
        actions.push({ id: node.id, type: "create_task", config: { title: node.config?.title ?? "Task" }, stopOnError: false });
      }
      emit(nextOf(nodeId));
      return;
    }
    if (node.type === "wait") {
      actions.push({ id: node.id, type: "wait", config: { days: Number(node.config?.days) || 0, hours: Number(node.config?.hours) || 0 }, stopOnError: false });
      emit(nextOf(nodeId));
      return;
    }
    if (node.type === "assign") {
      actions.push({ id: node.id, type: "assign_owner", config: { mode: node.config?.mode ?? "fixed", assigneeId: node.config?.assigneeId ?? "" }, stopOnError: false });
      emit(nextOf(nodeId));
      return;
    }
    if (node.type === "tag") {
      actions.push({ id: node.id, type: "add_tag", config: { tag: node.config?.tag ?? "" }, stopOnError: false });
      emit(nextOf(nodeId));
      return;
    }
    if (node.type === "branch") {
      const branchIdx = actions.length;
      actions.push({
        id: node.id,
        type: "branch",
        config: {
          behavior: node.config?.behavior,
          withinDays: node.config?.withinDays,
          conditions: node.config?.conditions ?? [],
        },
        stopOnError: false,
      });
      const outs = outEdges.get(nodeId) ?? [];
      const isTrue = (l?: string) => ["true", "yes", "opened", "clicked"].includes(String(l ?? "").toLowerCase());
      const trueEdge = outs.find((e) => isTrue(e.label));
      const falseEdge = outs.find((e) => e !== trueEdge);
      // False path falls through (right after the branch); then the true path.
      emit(falseEdge?.to ?? null);
      const trueStart = actions.length;
      emit(trueEdge?.to ?? null);
      actions[branchIdx].config.trueGoto = trueStart;
      return;
    }
    pushEnd();
  }

  if (trigger) emit(nextOf(trigger.id));
  return { trigger: triggerSpec, actions };
}

// ── CRUD (workflows kind='journey') ─────────────────────────────────────────
function shapeJourney(row: any) {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    description: row.description,
    isEnabled: row.isEnabled,
    kind: row.kind,
    trigger: typeof row.trigger === "string" ? JSON.parse(row.trigger) : row.trigger,
    canvas: parseCanvas(row.canvas),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listJourneys(companyId: string) {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id, "companyId", name, description, "isEnabled", kind, trigger, canvas, "createdAt", "updatedAt"
     FROM workflows WHERE "companyId" = $1 AND kind = 'journey' ORDER BY "updatedAt" DESC`,
    companyId
  )) as any[];
  return rows.map(shapeJourney);
}

export async function getJourney(companyId: string, id: string) {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id, "companyId", name, description, "isEnabled", kind, trigger, canvas, "createdAt", "updatedAt"
     FROM workflows WHERE id = $1 AND "companyId" = $2 AND kind = 'journey'`,
    id,
    companyId
  )) as any[];
  if (!rows[0]) throw notFound("Journey");
  return shapeJourney(rows[0]);
}

export async function createJourney(companyId: string, userId: string, dto: { name: string; canvas?: Canvas }) {
  if (!dto.name?.trim()) throw badRequest("name is required");
  const canvas = dto.canvas ?? { nodes: [], edges: [] };
  const { trigger, actions } = compileCanvas(canvas);
  const rows = (await prisma.$queryRawUnsafe(
    `INSERT INTO workflows (id, "companyId", "createdById", name, "isEnabled", kind, trigger, actions, conditions, canvas, "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, false, 'journey', $4::jsonb, $5::jsonb, '[]'::jsonb, $6, NOW(), NOW())
     RETURNING id, "companyId", name, description, "isEnabled", kind, trigger, canvas, "createdAt", "updatedAt"`,
    companyId,
    userId,
    dto.name.trim(),
    JSON.stringify(trigger),
    JSON.stringify(actions),
    JSON.stringify(canvas)
  )) as any[];
  return shapeJourney(rows[0]);
}

export async function updateJourney(companyId: string, id: string, patch: { name?: string; canvas?: Canvas }) {
  await getJourney(companyId, id);
  const sets: string[] = [];
  const params: any[] = [];
  const push = (frag: string, val: any) => { params.push(val); sets.push(frag.replace("$$", `$${params.length}`)); };
  if (patch.name !== undefined) push(`name = $$`, patch.name.trim());
  if (patch.canvas !== undefined) {
    const { trigger, actions } = compileCanvas(patch.canvas);
    push(`canvas = $$`, JSON.stringify(patch.canvas));
    push(`trigger = $$::jsonb`, JSON.stringify(trigger));
    push(`actions = $$::jsonb`, JSON.stringify(actions));
  }
  if (!sets.length) return getJourney(companyId, id);
  sets.push(`"updatedAt" = NOW()`);
  params.push(id, companyId);
  await prisma.$executeRawUnsafe(
    `UPDATE workflows SET ${sets.join(", ")} WHERE id = $${params.length - 1} AND "companyId" = $${params.length}`,
    ...params
  );
  return getJourney(companyId, id);
}

export async function setJourneyEnabled(companyId: string, id: string, enabled: boolean) {
  const j = await getJourney(companyId, id);
  if (enabled) {
    const issues = validateCanvas(j.canvas);
    const errors = issues.filter((i) => i.level === "error");
    if (errors.length) {
      throw new AppError(errors.map((e) => e.message).join("; "), 422, errors[0].code);
    }
  }
  await prisma.$executeRawUnsafe(
    `UPDATE workflows SET "isEnabled" = $1, "updatedAt" = NOW() WHERE id = $2 AND "companyId" = $3`,
    enabled,
    id,
    companyId
  );
  return getJourney(companyId, id);
}

export async function deleteJourney(companyId: string, id: string) {
  await getJourney(companyId, id);
  await prisma.$executeRawUnsafe(`DELETE FROM workflows WHERE id = $1 AND "companyId" = $2`, id, companyId);
  return { id, deleted: true };
}

// Test-run: compile + return the path a sample payload would take (no sends).
export function testRunPath(canvas: Canvas, samplePayload: Record<string, unknown>): string[] {
  const { actions } = compileCanvas(canvas);
  const path: string[] = [];
  for (let i = 0; i < actions.length && i >= 0; i++) {
    const a = actions[i];
    path.push(a.id);
    if (a.type === "branch") {
      // Sample evaluation: behavioral branches use samplePayload flags.
      const behavior = a.config.behavior as string | undefined;
      let passed = false;
      if (behavior) passed = Boolean(samplePayload[behavior]);
      const goto = a.config.trueGoto as number | undefined;
      if (passed && typeof goto === "number" && goto > i) { i = goto - 1; continue; }
      // false → fall through
    }
    if (a.type === "end") break;
  }
  return path;
}
