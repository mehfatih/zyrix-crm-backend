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
}

/**
 * Claim up to `limit` pending executions that are ready to run now.
 * Uses SKIP LOCKED so parallel workers can't claim the same row.
 * Transitions them to 'running' in the same transaction.
 */
async function claimPending(limit: number): Promise<PendingExecution[]> {
  // Postgres CTE: SELECT with lock + UPDATE + RETURN. Rows with
  // nextRetryAt > now are left untouched (they belong to the future).
  const rows = (await prisma.$queryRawUnsafe(
    `WITH claimed AS (
       SELECT id FROM workflow_executions
       WHERE status = 'pending'
         AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= NOW())
       ORDER BY "queuedAt" ASC
       FOR UPDATE SKIP LOCKED
       LIMIT ${limit}
     )
     UPDATE workflow_executions we
     SET status = 'running',
         "startedAt" = NOW(),
         attempts = attempts + 1,
         "nextRetryAt" = NULL
     FROM claimed
     WHERE we.id = claimed.id
     RETURNING we.id, we."workflowId", we."companyId",
               we."triggerPayload", we.attempts`
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

/**
 * Run the action chain. Returns the full step log + an overall
 * success/failure verdict. "Failure" here means at least one action
 * failed AND had stopOnError true; a non-stopping failure still allows
 * the execution to finish with status='completed' (common for
 * best-effort notification chains).
 */
async function runChain(
  actions: WorkflowAction[],
  companyId: string,
  payload: unknown,
  fallbackUserId: string
): Promise<{ ok: boolean; steps: StepResult[] }> {
  const steps: StepResult[] = [];
  let overallOk = true;
  for (const action of actions) {
    const startedAt = new Date().toISOString();
    if (action.delaySeconds && action.delaySeconds > 0) {
      // Simple delay — blocks the worker slot. Capped at 3600s in
      // sanitization so worst case we hold one slot for an hour.
      // Prefer event-driven patterns for longer delays; add a
      // dedicated 'delay' action in the future if needed.
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
        // Mark remaining actions as skipped so the UI shows them
        // distinctly from successful ones.
        const remaining = actions.slice(actions.indexOf(action) + 1);
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
  return { ok: overallOk, steps };
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

  // Check conditions. If they fail, mark skipped and don't touch
  // workflow stats — it's not a run, just a pass-over.
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

  const creator = await getCreator(wf.id);
  const chainResult = await runChain(
    wf.actions as WorkflowAction[],
    wf.companyId,
    exec.triggerPayload,
    creator
  );

  if (chainResult.ok) {
    // Success
    await prisma.$executeRawUnsafe(
      `UPDATE workflow_executions
       SET status = 'completed',
           "stepResults" = $1::jsonb,
           "finishedAt" = NOW()
       WHERE id = $2`,
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
    return;
  }

  // Failed — decide retry vs permanent
  const firstError =
    chainResult.steps.find((s) => s.status === "failed")?.error ??
    "unknown error";

  if (exec.attempts < MAX_ATTEMPTS) {
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
       WHERE id = $4`,
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
       WHERE id = $3`,
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
  } catch (err) {
    console.error("[workflows] schedule error:", (err as Error).message);
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
