// ============================================================================
// WORKFLOW EXECUTION WORKER
// ----------------------------------------------------------------------------
// Runs every 30 seconds. Claims up to 20 pending executions atomically via
// FOR UPDATE SKIP LOCKED (safe for horizontal scaling — multiple backend
// instances can run this cron without stepping on each other). For each
// claimed row it evaluates conditions, runs actions in sequence, logs
// stepResults, updates the parent Workflow's stats.
//
// Retry backoff for transient failures: [30s, 2m, 10m, 30m, 2h]. After the
// 6th failed attempt the execution transitions to 'failed' permanently
// so ops can inspect without it retrying forever.
// ============================================================================

import cron from "node-cron";
import { prisma } from "../config/database";
import {
  evaluateConditions,
  type WorkflowRow,
  type WorkflowAction,
  type WorkflowCondition,
} from "../services/workflows.service";
import { runAction } from "../services/workflow-actions";
import { recordIntegrationEvent } from "../services/integration-events.service";
import { contactHadEmailEvent } from "../services/email-query.service";

// Backoff ladder in seconds. Index = attempts count. Last value = max.
const RETRY_BACKOFF_SECONDS = [30, 120, 600, 1800, 7200];
const MAX_ATTEMPTS = 6;

let running = false;

interface PendingExecution {
  id: string;
  workflowId: string;
  companyId: string;
  triggerPayload: unknown;
  attempts: number;
  currentStep: number;
  stepResults: unknown;
}

/**
 * Claim up to `limit` executions that are ready to run now. Two kinds are
 * eligible:
 *   • 'pending'  — fresh or retry-due rows (nextRetryAt null/past)
 *   • 'waiting'  — parked on a wait step, due to resume (scheduledAt past)
 * Uses SKIP LOCKED so parallel workers can't claim the same row. Resuming a
 * waiting run does NOT count as a retry attempt (only pending claims bump
 * `attempts`), so multi-day waits never exhaust the retry budget.
 */
async function claimPending(limit: number): Promise<PendingExecution[]> {
  const rows = (await prisma.$queryRawUnsafe(
    `WITH claimed AS (
       SELECT id FROM workflow_executions
       WHERE (
           status = 'pending'
           AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= NOW())
         )
         OR (
           status = 'waiting'
           AND "scheduledAt" IS NOT NULL
           AND "scheduledAt" <= NOW()
         )
       ORDER BY "queuedAt" ASC
       FOR UPDATE SKIP LOCKED
       LIMIT ${limit}
     )
     UPDATE workflow_executions we
     SET status = 'running',
         "startedAt" = NOW(),
         attempts = attempts + CASE WHEN we.status = 'waiting' THEN 0 ELSE 1 END,
         "nextRetryAt" = NULL,
         "scheduledAt" = NULL
     FROM claimed
     WHERE we.id = claimed.id
     RETURNING we.id, we."workflowId", we."companyId",
               we."triggerPayload", we.attempts,
               we."currentStep", we."stepResults"`
  )) as PendingExecution[];
  return rows;
}

async function loadWorkflow(
  workflowId: string
): Promise<WorkflowRow | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT * FROM workflows WHERE id = $1 LIMIT 1`,
    workflowId
  )) as any[];
  if (rows.length === 0) return null;
  const r = rows[0];
  // JSON fields come back as already-parsed objects from Prisma's raw
  // query when the column type is JSONB. Guard anyway.
  const parseJson = (v: unknown) =>
    typeof v === "string" ? JSON.parse(v) : v;
  return {
    ...r,
    trigger: parseJson(r.trigger),
    actions: parseJson(r.actions),
    conditions: parseJson(r.conditions),
  } as WorkflowRow;
}

/**
 * Find the createdById for a workflow — used as the fallback assignee
 * for create_task actions that don't specify one.
 */
async function getCreator(workflowId: string): Promise<string> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT "createdById" FROM workflows WHERE id = $1 LIMIT 1`,
    workflowId
  )) as { createdById: string }[];
  return rows[0]?.createdById ?? "unknown";
}

interface StepResult {
  actionId: string;
  actionType: string;
  status: "success" | "failed" | "skipped";
  startedAt: string;
  finishedAt: string;
  error?: string;
  output?: unknown;
}

// Deterministic-failure message fragments. A failed action whose runner sets
// retryable:false, OR whose error matches one of these, will never succeed on
// retry (bad config / missing payload context / not-found reference) — so the
// worker dead-letters it immediately instead of cycling the backoff ladder.
const NON_RETRYABLE_PATTERNS = [
  "is empty",
  "is required",
  "are required",
  "requires",
  "no customer",
  "no deal",
  "needs a customer",
  "not found",
  "unknown action",
  "unknown assign",
  "unsupported",
  "no active users",
  "no members",
  "no territory matched",
  "neither owner",
  "is invalid",
  "invalid or missing",
];

function isNonRetryableFailure(result: { retryable?: boolean; error?: string }): boolean {
  if (result.retryable === false) return true;
  const e = (result.error ?? "").toLowerCase();
  return NON_RETRYABLE_PATTERNS.some((p) => e.includes(p));
}

/** Compute a wait step's duration in ms from its config (days/hours/minutes). */
function waitDurationMs(config: Record<string, unknown>): number {
  const days = Number(config.days ?? 0) || 0;
  const hours = Number(config.hours ?? 0) || 0;
  const minutes = Number(config.minutes ?? 0) || 0;
  let ms = ((days * 24 + hours) * 60 + minutes) * 60 * 1000;
  // Floor at 1 minute (a zero-duration wait is almost certainly a misconfig),
  // cap at 90 days so a typo can't park a run effectively forever.
  if (ms <= 0) ms = 60 * 1000;
  return Math.min(ms, 90 * 24 * 60 * 60 * 1000);
}

type ChainResult =
  | { kind: "done"; ok: boolean; steps: StepResult[]; retryable: boolean }
  | { kind: "wait"; resumeAt: Date; nextStep: number; steps: StepResult[] };

/**
 * Run the action chain from `startIndex`, carrying forward `priorSteps` (the
 * log accumulated before a wait). Returns either:
 *   • { kind:'done' } — chain finished (ok=false if a stopOnError action failed)
 *   • { kind:'wait' } — hit a wait step; caller parks the run until resumeAt
 *     and resumes at nextStep.
 */
async function runChain(
  actions: WorkflowAction[],
  companyId: string,
  payload: unknown,
  fallbackUserId: string,
  startIndex: number,
  priorSteps: StepResult[]
): Promise<ChainResult> {
  const steps: StepResult[] = [...priorSteps];
  let overallOk = true;
  // A deterministic failure (bad config / missing payload context / not-found
  // assignee) will never succeed on retry — surface it so the caller can
  // dead-letter immediately instead of cycling the 6-attempt backoff.
  let retryable = true;
  for (let i = startIndex; i < actions.length; i++) {
    const action = actions[i];
    const startedAt = new Date().toISOString();

    // ── end step: stop this path (journey terminal node) ───────────────
    if (action.type === "end") {
      steps.push({ actionId: action.id, actionType: "end", status: "success", startedAt, finishedAt: new Date().toISOString() });
      return { kind: "done", ok: overallOk, steps, retryable };
    }

    // ── branch step: evaluate conditions, jump the chain index ─────────
    // config: { conditions: [...], trueGoto?: number, falseGoto?: number }.
    // Goto indices are positions in this same action array (set by the journey
    // compiler). Missing goto = fall through to the next action.
    if (action.type === "branch") {
      // Behavioral branch (opened/clicked within N days) needs a DB lookup;
      // otherwise evaluate plain payload conditions.
      let passed: boolean;
      const behavior = action.config?.behavior as string | undefined;
      if (behavior === "opened" || behavior === "clicked") {
        const p = payload as { contactId?: string; customerId?: string } | null;
        const contactId = p?.contactId ?? p?.customerId ?? null;
        const withinDays = Number(action.config?.withinDays) || 2;
        passed = contactId
          ? await contactHadEmailEvent(companyId, contactId, behavior === "clicked" ? "click" : "open", withinDays)
          : false;
      } else {
        passed = evaluateConditions((action.config?.conditions as WorkflowCondition[]) ?? [], payload);
      }
      const trueGoto = action.config?.trueGoto;
      const falseGoto = action.config?.falseGoto;
      const goto = passed ? trueGoto : falseGoto;
      steps.push({
        actionId: action.id,
        actionType: "branch",
        status: "success",
        startedAt,
        finishedAt: new Date().toISOString(),
        output: { passed, goto: goto ?? null },
      });
      if (typeof goto === "number" && goto > i && goto <= actions.length) {
        i = goto - 1; // -1 because the for-loop will ++ ; only forward jumps
      }
      continue;
    }

    // ── wait step: park the run and resume later ──────────────────────
    if (action.type === "wait") {
      const ms = waitDurationMs(action.config);
      const resumeAt = new Date(Date.now() + ms);
      steps.push({
        actionId: action.id,
        actionType: "wait",
        status: "success",
        startedAt,
        finishedAt: new Date().toISOString(),
        output: { resumeAt: resumeAt.toISOString(), waitMs: ms },
      });
      return { kind: "wait", resumeAt, nextStep: i + 1, steps };
    }

    if (action.delaySeconds && action.delaySeconds > 0) {
      // Short inline delay — blocks the worker slot. Capped at 3600s in
      // sanitization. For longer pauses use a dedicated wait step.
      await new Promise((r) => setTimeout(r, action.delaySeconds! * 1000));
    }
    const result = await runAction(
      action.type,
      companyId,
      action.config,
      payload,
      fallbackUserId
    );
    const finishedAt = new Date().toISOString();
    if (result.ok) {
      steps.push({
        actionId: action.id,
        actionType: action.type,
        status: "success",
        startedAt,
        finishedAt,
        output: result.output,
      });
    } else {
      steps.push({
        actionId: action.id,
        actionType: action.type,
        status: "failed",
        startedAt,
        finishedAt,
        error: result.error,
        output: result.output,
      });
      if (action.stopOnError !== false) {
        overallOk = false;
        // Permanent (deterministic) error → don't retry.
        if (isNonRetryableFailure(result)) retryable = false;
        // Mark remaining actions as skipped so the UI shows them
        // distinctly from successful ones.
        const remaining = actions.slice(i + 1);
        for (const skipped of remaining) {
          steps.push({
            actionId: skipped.id,
            actionType: skipped.type,
            status: "skipped",
            startedAt: finishedAt,
            finishedAt,
          });
        }
        break;
      }
    }
  }
  return { kind: "done", ok: overallOk, steps, retryable };
}

/**
 * Process one execution end-to-end: load workflow, evaluate conditions,
 * run chain, write back stepResults + status, bump workflow stats,
 * schedule retry on transient-looking failures.
 */
async function processOne(exec: PendingExecution): Promise<void> {
  const wf = await loadWorkflow(exec.workflowId);
  if (!wf) {
    await prisma.$executeRawUnsafe(
      `UPDATE workflow_executions
       SET status = 'failed',
           "finishedAt" = NOW(),
           "lastError" = 'Workflow was deleted'
       WHERE id = $1`,
      exec.id
    );
    return;
  }

  // Conditions are evaluated once, on the first pass (currentStep === 0).
  // A run resuming from a wait (currentStep > 0) already passed them.
  if (exec.currentStep === 0) {
    const conditions = wf.conditions as WorkflowCondition[];
    if (!evaluateConditions(conditions, exec.triggerPayload)) {
      await prisma.$executeRawUnsafe(
        `UPDATE workflow_executions
         SET status = 'skipped_conditions',
             "finishedAt" = NOW()
         WHERE id = $1`,
        exec.id
      );
      return;
    }
  }

  const priorSteps: StepResult[] = Array.isArray(exec.stepResults)
    ? (exec.stepResults as StepResult[])
    : typeof exec.stepResults === "string"
    ? (JSON.parse(exec.stepResults) as StepResult[])
    : [];

  const creator = await getCreator(wf.id);
  const chainResult = await runChain(
    wf.actions as WorkflowAction[],
    wf.companyId,
    exec.triggerPayload,
    creator,
    exec.currentStep ?? 0,
    priorSteps
  );

  // Hit a wait step — park the run and resume at scheduledAt.
  if (chainResult.kind === "wait") {
    await prisma.$executeRawUnsafe(
      `UPDATE workflow_executions
       SET status = 'waiting',
           "stepResults" = $1::jsonb,
           "currentStep" = $2,
           "scheduledAt" = $3,
           "startedAt" = NULL
       WHERE id = $4 AND status = 'running'`,
      JSON.stringify(chainResult.steps),
      chainResult.nextStep,
      chainResult.resumeAt,
      exec.id
    );
    return;
  }

  if (chainResult.ok) {
    // Success
    await prisma.$executeRawUnsafe(
      `UPDATE workflow_executions
       SET status = 'completed',
           "stepResults" = $1::jsonb,
           "finishedAt" = NOW()
       WHERE id = $2 AND status = 'running'`,
      JSON.stringify(chainResult.steps),
      exec.id
    );
    await prisma.$executeRawUnsafe(
      `UPDATE workflows
       SET "runCount" = "runCount" + 1,
           "successCount" = "successCount" + 1,
           "lastRunAt" = NOW(),
           "lastSuccessAt" = NOW(),
           "lastError" = NULL,
           "updatedAt" = NOW()
       WHERE id = $1`,
      wf.id
    );
    recordIntegrationEvent({
      companyId: wf.companyId,
      platform: "automation",
      eventType: "workflow_run_completed",
      requestContext: { workflowId: wf.id, executionId: exec.id },
    }).catch(() => {});
    return;
  }

  // Failed — decide retry vs permanent
  const firstError =
    chainResult.steps.find((s) => s.status === "failed")?.error ??
    "unknown error";

  // Retry only transient failures. A non-retryable (deterministic) failure —
  // bad config, missing payload context, unknown assignee — dead-letters at
  // once instead of cycling the backoff ladder for hours.
  if (chainResult.retryable && exec.attempts < MAX_ATTEMPTS) {
    const backoffSec =
      RETRY_BACKOFF_SECONDS[exec.attempts - 1] ??
      RETRY_BACKOFF_SECONDS[RETRY_BACKOFF_SECONDS.length - 1];
    const nextRetryAt = new Date(Date.now() + backoffSec * 1000);
    await prisma.$executeRawUnsafe(
      `UPDATE workflow_executions
       SET status = 'pending',
           "stepResults" = $1::jsonb,
           "lastError" = $2,
           "nextRetryAt" = $3,
           "startedAt" = NULL
       WHERE id = $4 AND status = 'running'`,
      JSON.stringify(chainResult.steps),
      firstError.slice(0, 500),
      nextRetryAt,
      exec.id
    );
  } else {
    // Dead letter
    await prisma.$executeRawUnsafe(
      `UPDATE workflow_executions
       SET status = 'failed',
           "stepResults" = $1::jsonb,
           "lastError" = $2,
           "finishedAt" = NOW()
       WHERE id = $3 AND status = 'running'`,
      JSON.stringify(chainResult.steps),
      firstError.slice(0, 500),
      exec.id
    );
    await prisma.$executeRawUnsafe(
      `UPDATE workflows
       SET "runCount" = "runCount" + 1,
           "failureCount" = "failureCount" + 1,
           "lastRunAt" = NOW(),
           "lastFailureAt" = NOW(),
           "lastError" = $1,
           "updatedAt" = NOW()
       WHERE id = $2`,
      firstError.slice(0, 500),
      wf.id
    );
    recordIntegrationEvent({
      companyId: wf.companyId,
      platform: "automation",
      eventType: "workflow_run_failed",
      errorMessage: firstError.slice(0, 500),
      requestContext: { workflowId: wf.id, executionId: exec.id },
    }).catch(() => {});
  }
}

/**
 * One tick: claim up to N and process them in parallel.
 */
async function tick() {
  if (running) return; // belt-and-braces — skip if previous tick still active
  running = true;
  try {
    const claimed = await claimPending(20);
    if (claimed.length === 0) return;
    console.log(`[workflows] processing ${claimed.length} executions`);
    await Promise.allSettled(claimed.map((e) => processOne(e)));
  } catch (err) {
    console.error("[workflows] tick error:", (err as Error).message);
  } finally {
    running = false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// SCHEDULED TRIGGERS — schedule.daily / schedule.weekly
// ──────────────────────────────────────────────────────────────────────

async function runSchedules() {
  try {
    const now = new Date();
    const hour = now.getUTCHours();
    const dow = [
      "sunday",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
    ][now.getUTCDay()];

    // Daily triggers — just match on hour
    const daily = (await prisma.$queryRawUnsafe(
      `SELECT id, "companyId" FROM workflows
       WHERE "isEnabled" = true
         AND trigger->>'type' = 'schedule.daily'
         AND (trigger->'config'->>'hour')::int = $1`,
      hour
    )) as { id: string; companyId: string }[];

    for (const wf of daily) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO workflow_executions
           (id, "workflowId", "companyId", "triggerPayload", status, "queuedAt")
         VALUES (gen_random_uuid(), $1, $2, $3::jsonb, 'pending', NOW())`,
        wf.id,
        wf.companyId,
        JSON.stringify({
          event: "schedule.daily",
          timestamp: now.toISOString(),
        })
      );
    }

    // Weekly triggers — day + hour both must match
    const weekly = (await prisma.$queryRawUnsafe(
      `SELECT id, "companyId" FROM workflows
       WHERE "isEnabled" = true
         AND trigger->>'type' = 'schedule.weekly'
         AND trigger->'config'->>'dayOfWeek' = $1
         AND (trigger->'config'->>'hour')::int = $2`,
      dow,
      hour
    )) as { id: string; companyId: string }[];

    for (const wf of weekly) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO workflow_executions
           (id, "workflowId", "companyId", "triggerPayload", status, "queuedAt")
         VALUES (gen_random_uuid(), $1, $2, $3::jsonb, 'pending', NOW())`,
        wf.id,
        wf.companyId,
        JSON.stringify({
          event: "schedule.weekly",
          timestamp: now.toISOString(),
        })
      );
    }

    if (daily.length + weekly.length > 0) {
      console.log(
        `[workflows] scheduled ${daily.length} daily + ${weekly.length} weekly triggers`
      );
    }

    // Daily deal.idle scan — runs once per day at a fixed UTC hour so the
    // hourly dispatcher doesn't re-fire idle deals every hour.
    if (hour === IDLE_SCAN_HOUR_UTC) {
      await runIdleScan(now);
    }
  } catch (err) {
    console.error("[workflows] schedule error:", (err as Error).message);
  }
}

// ──────────────────────────────────────────────────────────────────────
// DEAL.IDLE SCAN
// ----------------------------------------------------------------------------
// Once a day, for each enabled deal.idle workflow, find open deals that have
// had no update for `idleDays` and enqueue a run. A NOT EXISTS guard against
// recent executions for the same (workflow, deal) prevents re-firing the same
// idle deal on consecutive days within the idle window.
// ──────────────────────────────────────────────────────────────────────

const IDLE_SCAN_HOUR_UTC = 7;

async function runIdleScan(now: Date) {
  const wfs = (await prisma.$queryRawUnsafe(
    `SELECT id, "companyId", trigger FROM workflows
     WHERE "isEnabled" = true AND trigger->>'type' = 'deal.idle'`
  )) as { id: string; companyId: string; trigger: any }[];

  let enqueued = 0;
  for (const wf of wfs) {
    const trig = typeof wf.trigger === "string" ? JSON.parse(wf.trigger) : wf.trigger;
    const cfg = (trig?.config ?? {}) as Record<string, unknown>;
    const idleDays = Math.max(1, Number(cfg.idleDays ?? 3) || 3);
    const stage = typeof cfg.stage === "string" ? cfg.stage.trim() : "";

    const params: (string | number)[] = [wf.companyId, wf.id, idleDays];
    let stageClause = "";
    if (stage) {
      params.push(stage);
      stageClause = `AND d.stage = $${params.length}`;
    }

    const deals = (await prisma.$queryRawUnsafe(
      `SELECT d.id, d.title, d.value, d.currency, d.stage, d."customerId",
              c."fullName" AS "customerName", c.email AS "customerEmail",
              c.phone AS "customerPhone"
       FROM deals d
       LEFT JOIN customers c ON c.id = d."customerId"
       WHERE d."companyId" = $1
         AND d.stage NOT IN ('won', 'lost')
         AND d."updatedAt" <= NOW() - ($3 || ' days')::interval
         ${stageClause}
         AND NOT EXISTS (
           SELECT 1 FROM workflow_executions we
           WHERE we."workflowId" = $2
             AND we."triggerPayload"->'deal'->>'id' = d.id
             AND we."queuedAt" > NOW() - ($3 || ' days')::interval
         )
       LIMIT 500`,
      ...params
    )) as any[];

    for (const d of deals) {
      const payload = {
        event: "deal.idle",
        timestamp: now.toISOString(),
        deal: {
          id: d.id,
          title: d.title,
          value: Number(d.value),
          currency: d.currency,
          stage: d.stage,
          idleDays,
        },
        customer: d.customerId
          ? {
              id: d.customerId,
              fullName: d.customerName,
              email: d.customerEmail,
              phone: d.customerPhone,
            }
          : null,
        customerId: d.customerId,
      };
      await prisma.$executeRawUnsafe(
        `INSERT INTO workflow_executions
           (id, "workflowId", "companyId", "triggerPayload", status, "queuedAt")
         VALUES (gen_random_uuid(), $1, $2, $3::jsonb, 'pending', NOW())`,
        wf.id,
        wf.companyId,
        JSON.stringify(payload)
      );
      enqueued++;
    }
  }
  if (enqueued > 0) {
    console.log(`[workflows] deal.idle scan enqueued ${enqueued} runs`);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Start both cron jobs
// ──────────────────────────────────────────────────────────────────────

export function startWorkflowWorker() {
  // Execution worker — every 30 seconds (two hits per minute)
  cron.schedule("*/30 * * * * *", tick);
  // Schedule dispatcher — top of every hour
  cron.schedule("0 * * * *", runSchedules);
  console.log(
    "[workflows] worker started (exec every 30s, schedule every hour)"
  );
}
