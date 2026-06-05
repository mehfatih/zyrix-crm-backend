// ============================================================================
// CADENCE SERVICE — Sprint 11
// ----------------------------------------------------------------------------
// Cadences are linear follow-up sequences that COMPILE into the Sprint-6
// automation engine (one executor). A cadence's steps become a workflow's
// action chain (sends/tasks separated by `wait` steps); each enrollment is one
// engine execution. Editing an ACTIVE cadence compiles a NEW workflow version
// and repoints automationId — in-flight enrollments stay bound to their
// original workflow (finish on the old plan). Auto-exit cancels the run.
// ============================================================================

import { prisma } from "../config/database";
import { env } from "../config/env";
import { AppError, badRequest, notFound } from "../middleware/errorHandler";
import { enqueueExecution, cancelExecution } from "./workflows.service";
import { dispatchCadenceExited } from "./workflow-events.service";

export type CadenceChannel = "whatsapp" | "email" | "task" | "call_task";

export interface CadenceStep {
  channel: CadenceChannel;
  delayDays?: number;
  delayHours?: number;
  name?: string;
  // whatsapp:
  templateRef?: { name: string; lang?: string };
  // email:
  subject?: string;
  body?: string;
}

export interface ExitRules {
  onReply?: boolean;
  onDealWon?: boolean;
  onUnsubscribe?: boolean;
}

const DEFAULT_EXIT: ExitRules = { onReply: true, onDealWon: true, onUnsubscribe: true };

function parseSteps(raw: string): CadenceStep[] {
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch { return []; }
}
function parseExit(raw: string): ExitRules {
  try { return { ...DEFAULT_EXIT, ...(JSON.parse(raw) || {}) }; } catch { return DEFAULT_EXIT; }
}

// ── Compiler ────────────────────────────────────────────────────────────────
// Validate a cadence is activatable. WhatsApp steps fire days later (outside
// any 24h session window) so they MUST carry an approved template.
export function validateCadence(steps: CadenceStep[]): void {
  if (!steps.length) throw badRequest("A cadence needs at least one step");
  steps.forEach((s, i) => {
    if (s.channel === "whatsapp" && !s.templateRef?.name) {
      throw new AppError(
        `Step ${i + 1}: WhatsApp steps require an approved template (they send outside the 24-hour session window).`,
        422,
        "WHATSAPP_TEMPLATE_REQUIRED"
      );
    }
    if (s.channel === "email" && !s.subject) {
      throw badRequest(`Step ${i + 1}: email steps need a subject`);
    }
  });
}

interface CompiledAction {
  id: string;
  type: string;
  config: Record<string, unknown>;
  stopOnError: boolean;
}

// steps → engine action chain. Each step is preceded by a wait for its delay.
export function compileSteps(steps: CadenceStep[], cadenceId: string): CompiledAction[] {
  const actions: CompiledAction[] = [];
  steps.forEach((s, i) => {
    const days = Number(s.delayDays) || 0;
    const hours = Number(s.delayHours) || 0;
    if (days > 0 || hours > 0) {
      actions.push({ id: `s${i}-wait`, type: "wait", config: { days, hours }, stopOnError: false });
    }
    const meta = { _cadenceId: cadenceId, _stepIndex: i };
    if (s.channel === "email") {
      actions.push({
        id: `s${i}`,
        type: "send_email",
        config: { toEmail: "{{contact.email}}", subject: s.subject ?? "", body: s.body ?? "", ...meta },
        stopOnError: false,
      });
    } else if (s.channel === "whatsapp") {
      actions.push({
        id: `s${i}`,
        type: "send_whatsapp_template",
        config: { toPhone: "{{contact.phone}}", templateName: s.templateRef?.name ?? "", templateLang: s.templateRef?.lang ?? "en", ...meta },
        stopOnError: false,
      });
    } else {
      // task | call_task
      actions.push({
        id: `s${i}`,
        type: "create_task",
        config: { title: s.name || (s.channel === "call_task" ? "Call contact" : "Follow up"), customerId: "{{contactId}}", priority: "high", ...meta },
        stopOnError: false,
      });
    }
  });
  return actions;
}

// Insert a compiled engine workflow (kind='cadence'). trigger type 'cadence'
// is never dispatched, so it only runs via enqueueExecution at enrollment.
async function compileToWorkflow(
  companyId: string,
  userId: string,
  cadence: { id: string; name: string; steps: CadenceStep[] }
): Promise<string> {
  const actions = compileSteps(cadence.steps, cadence.id);
  const rows = (await prisma.$queryRawUnsafe(
    `INSERT INTO workflows
       (id, "companyId", "createdById", name, description, "isEnabled", kind,
        trigger, actions, conditions, "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, $4, true, 'cadence',
        $5::jsonb, $6::jsonb, '[]'::jsonb, NOW(), NOW())
     RETURNING id`,
    companyId,
    userId,
    `Cadence: ${cadence.name}`,
    `Compiled cadence ${cadence.id}`,
    JSON.stringify({ type: "cadence", config: { cadenceId: cadence.id } }),
    JSON.stringify(actions)
  )) as { id: string }[];
  return rows[0].id;
}

// ── CRUD ──────────────────────────────────────────────────────────────────
export interface CadenceDto {
  name: string;
  description?: string | null;
  steps: CadenceStep[];
  exitRules?: ExitRules;
}

function shape(row: any) {
  return {
    ...row,
    steps: parseSteps(row.steps),
    exitRules: parseExit(row.exitRules),
  };
}

export async function listCadences(companyId: string) {
  const rows = await prisma.cadence.findMany({ where: { companyId }, orderBy: { updatedAt: "desc" } });
  // enrolled counts
  const counts = await prisma.cadenceEnrollment.groupBy({
    by: ["cadenceId", "status"],
    where: { companyId },
    _count: { _all: true },
  });
  const active = new Map<string, number>();
  for (const c of counts) if (c.status === "active") active.set(c.cadenceId, c._count._all);
  return rows.map((r) => ({ ...shape(r), activeEnrollments: active.get(r.id) ?? 0 }));
}

export async function getCadence(companyId: string, id: string) {
  const row = await prisma.cadence.findFirst({ where: { id, companyId } });
  if (!row) throw notFound("Cadence");
  return shape(row);
}

export async function createCadence(companyId: string, dto: CadenceDto) {
  if (!dto.name?.trim()) throw badRequest("name is required");
  const row = await prisma.cadence.create({
    data: {
      companyId,
      name: dto.name.trim(),
      description: dto.description ?? null,
      steps: JSON.stringify(dto.steps ?? []),
      exitRules: JSON.stringify({ ...DEFAULT_EXIT, ...(dto.exitRules ?? {}) }),
      status: "draft",
    },
  });
  return shape(row);
}

export async function updateCadence(companyId: string, userId: string, id: string, patch: Partial<CadenceDto>) {
  const existing = await getCadence(companyId, id);
  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) data.name = patch.name.trim();
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.steps !== undefined) data.steps = JSON.stringify(patch.steps);
  if (patch.exitRules !== undefined) data.exitRules = JSON.stringify({ ...DEFAULT_EXIT, ...patch.exitRules });

  // Edit-while-active → recompile a NEW workflow version for FUTURE enrollments.
  // In-flight runs keep their original workflowId and finish on the old plan.
  if (existing.status === "active" && patch.steps !== undefined) {
    const newSteps = patch.steps;
    validateCadence(newSteps);
    const newWorkflowId = await compileToWorkflow(companyId, userId, { id, name: patch.name?.trim() ?? existing.name, steps: newSteps });
    data.automationId = newWorkflowId;
  }
  const row = await prisma.cadence.update({ where: { id }, data });
  return shape(row);
}

export async function activateCadence(companyId: string, userId: string, id: string) {
  const c = await getCadence(companyId, id);
  validateCadence(c.steps); // throws WHATSAPP_TEMPLATE_REQUIRED etc.
  const workflowId = await compileToWorkflow(companyId, userId, { id, name: c.name, steps: c.steps });
  const row = await prisma.cadence.update({
    where: { id },
    data: { status: "active", automationId: workflowId },
  });
  return shape(row);
}

export async function pauseCadence(companyId: string, id: string) {
  await getCadence(companyId, id);
  // Pause stops NEW enrollments; in-flight enrollments continue.
  const row = await prisma.cadence.update({ where: { id }, data: { status: "paused" } });
  return shape(row);
}

export async function deleteCadence(companyId: string, id: string) {
  await getCadence(companyId, id);
  await prisma.cadence.delete({ where: { id } });
  return { id, deleted: true };
}

// ── Stats ─────────────────────────────────────────────────────────────────
// Incremented from engine send actions (sent) + Sprint-10 open/click signals.
export async function bumpStepStat(
  cadenceId: string,
  stepIndex: number,
  field: "sent" | "opened" | "clicked" | "replied",
  by = 1
): Promise<void> {
  try {
    await prisma.cadenceStepStat.upsert({
      where: { cadenceId_stepIndex: { cadenceId, stepIndex } },
      create: { cadenceId, stepIndex, [field]: by } as any,
      update: { [field]: { increment: by } } as any,
    });
  } catch (e) {
    console.error("[cadence] bumpStepStat failed (non-fatal):", (e as Error).message);
  }
}

// Per-step funnel + enrollment roll-up (replies are cadence-level by exit reason,
// since a per-step reply attribution isn't reliable — honest over guessed).
export async function getCadenceFunnel(companyId: string, cadenceId: string) {
  const cadence = await getCadence(companyId, cadenceId);
  const stats = await prisma.cadenceStepStat.findMany({
    where: { cadenceId },
    orderBy: { stepIndex: "asc" },
  });
  const byStep = new Map(stats.map((s) => [s.stepIndex, s]));
  const steps = cadence.steps.map((step: CadenceStep, i: number) => {
    const s = byStep.get(i);
    return {
      stepIndex: i,
      channel: step.channel,
      name: step.name ?? null,
      sent: s?.sent ?? 0,
      opened: s?.opened ?? 0,
      clicked: s?.clicked ?? 0,
    };
  });
  const enrollAgg = await prisma.cadenceEnrollment.groupBy({
    by: ["status"],
    where: { companyId, cadenceId },
    _count: { _all: true },
  });
  const exitAgg = await prisma.cadenceEnrollment.groupBy({
    by: ["exitReason"],
    where: { companyId, cadenceId, status: "exited" },
    _count: { _all: true },
  });
  const statusCounts: Record<string, number> = {};
  for (const e of enrollAgg) statusCounts[e.status] = e._count._all;
  const exitCounts: Record<string, number> = {};
  for (const e of exitAgg) if (e.exitReason) exitCounts[e.exitReason] = e._count._all;
  return {
    cadenceId,
    steps,
    enrollment: {
      total: enrollAgg.reduce((a, e) => a + e._count._all, 0),
      active: statusCounts.active ?? 0,
      exited: statusCounts.exited ?? 0,
      completed: statusCounts.completed ?? 0,
      repliedExits: exitCounts.replied ?? 0,
      dealWonExits: exitCounts.deal_won ?? 0,
    },
  };
}

// ── Enrollment ──────────────────────────────────────────────────────────────
async function resolveContact(companyId: string, contactId: string) {
  return prisma.customer.findFirst({
    where: { id: contactId, companyId },
    select: { id: true, fullName: true, email: true, phone: true, whatsappPhone: true },
  });
}

export async function enrollContacts(
  companyId: string,
  userId: string,
  cadenceId: string,
  contactIds: string[]
): Promise<{ enrolled: number; skipped: number; reasons: Record<string, string> }> {
  const c = await getCadence(companyId, cadenceId);
  if (c.status !== "active" || !c.automationId) {
    throw badRequest("Cadence must be active before enrolling contacts");
  }
  let enrolled = 0;
  let skipped = 0;
  const reasons: Record<string, string> = {};
  for (const contactId of [...new Set(contactIds)]) {
    const contact = await resolveContact(companyId, contactId);
    if (!contact) { skipped++; reasons[contactId] = "not_found"; continue; }
    // Active-enrollment guard (partial unique index also enforces this).
    const active = await prisma.cadenceEnrollment.findFirst({
      where: { cadenceId, contactId, status: "active" },
      select: { id: true },
    });
    if (active) { skipped++; reasons[contactId] = "already_enrolled"; continue; }

    const payload = {
      cadenceId,
      contactId,
      customerId: contactId,
      contact: {
        id: contact.id,
        fullName: contact.fullName,
        email: contact.email,
        phone: contact.whatsappPhone || contact.phone,
      },
    };
    try {
      const { executionId } = await enqueueExecution(c.automationId, companyId, payload);
      await prisma.cadenceEnrollment.create({
        data: { companyId, cadenceId, contactId, runId: executionId, status: "active" },
      });
      enrolled++;
    } catch (e) {
      skipped++; reasons[contactId] = "enqueue_failed";
    }
  }
  return { enrolled, skipped, reasons };
}

// Enroll everyone with a given tag.
export async function enrollByTag(companyId: string, userId: string, cadenceId: string, tagId: string) {
  const links = await prisma.customerTag.findMany({
    where: { tagId, customer: { companyId } },
    select: { customerId: true },
  });
  return enrollContacts(companyId, userId, cadenceId, links.map((l) => l.customerId));
}

// ── Auto-exit ────────────────────────────────────────────────────────────────
async function exitEnrollmentRow(
  companyId: string,
  enr: { id: string; cadenceId: string; contactId: string; runId: string | null },
  reason: string
): Promise<void> {
  if (enr.runId) await cancelExecution(enr.runId, companyId, `cadence_exit:${reason}`).catch(() => {});
  await prisma.cadenceEnrollment.update({
    where: { id: enr.id },
    data: { status: "exited", exitReason: reason, endedAt: new Date() },
  });
  void dispatchCadenceExited(companyId, { cadenceId: enr.cadenceId, contactId: enr.contactId, reason });
}

// Called from the unified-inbox inbound hooks (WhatsApp/Messenger/IG) when a
// contact replies. Exits their active enrollments whose cadence has onReply.
export async function onContactReplied(companyId: string, contactId: string): Promise<void> {
  await exitForReason(companyId, contactId, "replied", (ex) => ex.onReply !== false);
}

// Called from the deal stage-change hook when a deal is won.
export async function onContactDealWon(companyId: string, contactId: string): Promise<void> {
  await exitForReason(companyId, contactId, "deal_won", (ex) => ex.onDealWon !== false);
}

async function exitForReason(
  companyId: string,
  contactId: string,
  reason: string,
  ruleAllows: (ex: ExitRules) => boolean
): Promise<void> {
  try {
    const enrollments = await prisma.cadenceEnrollment.findMany({
      where: { companyId, contactId, status: "active" },
      select: { id: true, cadenceId: true, contactId: true, runId: true },
    });
    if (!enrollments.length) return;
    for (const enr of enrollments) {
      const cad = await prisma.cadence.findUnique({ where: { id: enr.cadenceId }, select: { exitRules: true } });
      if (!cad) continue;
      if (!ruleAllows(parseExit(cad.exitRules))) continue;
      await exitEnrollmentRow(companyId, enr, reason);
    }
  } catch (e) {
    console.error("[cadence] exitForReason failed (non-fatal):", (e as Error).message);
  }
}

// Manual unenroll.
export async function unenroll(companyId: string, enrollmentId: string): Promise<{ exited: boolean }> {
  const enr = await prisma.cadenceEnrollment.findFirst({
    where: { id: enrollmentId, companyId, status: "active" },
    select: { id: true, cadenceId: true, contactId: true, runId: true },
  });
  if (!enr) return { exited: false };
  await exitEnrollmentRow(companyId, enr, "manual");
  return { exited: true };
}

// ── Smart Follow-up preset (Sprint 11 Phase F) ──────────────────────────────
// Behind the SMART_FOLLOWUP_ON_ENGINE env flag (default OFF). When OFF, the
// standalone Smart Follow-up feature is completely untouched and this seeds
// nothing — the cutover is a later, deliberate flip.
export function smartFollowupOnEngine(): boolean {
  return String(env.SMART_FOLLOWUP_ON_ENGINE).toLowerCase() === "true";
}

const SMART_FOLLOWUP_NAME = "Smart Follow-up";

// The preset mirrors the follow-up intent: a task now, an email nudge in a few
// days, then a call task — auto-exits on reply or a won deal.
function smartFollowupSteps(): CadenceStep[] {
  return [
    { channel: "call_task", name: "Follow up with this contact", delayDays: 0 },
    {
      channel: "email",
      delayDays: 3,
      subject: "Just checking in",
      body: "Hi,\n\nWanted to follow up and see if you had any questions. Happy to help.\n\nBest regards",
    },
    { channel: "call_task", name: "Call — still no response", delayDays: 7 },
  ];
}

// Idempotent: returns the existing preset cadence if already seeded.
export async function seedSmartFollowupPreset(companyId: string, _userId: string) {
  if (!smartFollowupOnEngine()) {
    throw new AppError(
      "Smart Follow-up on the engine is disabled (SMART_FOLLOWUP_ON_ENGINE is off).",
      409,
      "SMART_FOLLOWUP_OFF"
    );
  }
  const existing = await prisma.cadence.findFirst({
    where: { companyId, name: SMART_FOLLOWUP_NAME },
  });
  if (existing) return { ...shape(existing), preset: true };
  const row = await prisma.cadence.create({
    data: {
      companyId,
      name: SMART_FOLLOWUP_NAME,
      description: "Built-in preset migrated from Smart Follow-up.",
      steps: JSON.stringify(smartFollowupSteps()),
      exitRules: JSON.stringify(DEFAULT_EXIT),
      status: "draft",
    },
  });
  return { ...shape(row), preset: true };
}

// Enrollments for a contact (for the contact cadence badge).
export async function enrollmentsForContact(companyId: string, contactId: string) {
  const rows = await prisma.cadenceEnrollment.findMany({
    where: { companyId, contactId },
    orderBy: { enrolledAt: "desc" },
  });
  const cadIds = [...new Set(rows.map((r) => r.cadenceId))];
  const cads = await prisma.cadence.findMany({ where: { id: { in: cadIds } }, select: { id: true, name: true } });
  const nameById = new Map(cads.map((c) => [c.id, c.name]));
  return rows.map((r) => ({ ...r, cadenceName: nameById.get(r.cadenceId) ?? "Cadence" }));
}
