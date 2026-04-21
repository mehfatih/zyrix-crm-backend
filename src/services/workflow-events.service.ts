// ============================================================================
// WORKFLOW EVENT DISPATCHER
// ----------------------------------------------------------------------------
// Called from existing services (customer, deal, activity) whenever a
// business event occurs. For each matching enabled workflow, we create a
// pending WorkflowExecution row. The cron worker picks it up and runs.
//
// Every dispatch* function is fire-and-forget — never throws, never awaits
// the execution itself. The primary action (saving a customer, closing a
// deal) must always complete even if workflow matching hits an error.
// ============================================================================

import { prisma } from "../config/database";
import { enqueueExecution } from "./workflows.service";

interface WorkflowMatch {
  id: string;
  companyId: string;
  trigger: { type: string; config?: Record<string, unknown> };
}

/**
 * Find enabled workflows in this company that match the given trigger type.
 * Secondary filtering (e.g. status/stage config) happens in-memory so we
 * don't have to build a query per trigger.
 */
async function findMatching(
  companyId: string,
  triggerType: string
): Promise<WorkflowMatch[]> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id, "companyId", trigger FROM workflows
     WHERE "companyId" = $1
       AND "isEnabled" = true
       AND trigger->>'type' = $2`,
    companyId,
    triggerType
  )) as any[];
  return rows.map((r) => ({
    id: r.id,
    companyId: r.companyId,
    trigger:
      typeof r.trigger === "string" ? JSON.parse(r.trigger) : r.trigger,
  }));
}

/** Never throws — logs and continues. */
async function safeDispatch(
  triggerType: string,
  companyId: string,
  payload: unknown,
  configFilter?: (config: Record<string, unknown>) => boolean
): Promise<void> {
  try {
    const matches = await findMatching(companyId, triggerType);
    for (const m of matches) {
      const cfg = m.trigger.config ?? {};
      if (configFilter && !configFilter(cfg)) continue;
      try {
        await enqueueExecution(m.id, m.companyId, payload);
      } catch (e) {
        console.error(
          `[workflow-events] enqueue failed for workflow ${m.id}:`,
          (e as Error).message
        );
      }
    }
  } catch (e) {
    console.error(
      `[workflow-events] ${triggerType} dispatch failed:`,
      (e as Error).message
    );
  }
}

// ──────────────────────────────────────────────────────────────────────
// CUSTOMER EVENTS
// ──────────────────────────────────────────────────────────────────────

interface CustomerPayload {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  status: string;
  source: string | null;
}

export async function dispatchCustomerCreated(
  companyId: string,
  customer: CustomerPayload
): Promise<void> {
  await safeDispatch("customer.created", companyId, {
    event: "customer.created",
    timestamp: new Date().toISOString(),
    customer,
    customerId: customer.id,
  });
}

export async function dispatchCustomerStatusChanged(
  companyId: string,
  customer: CustomerPayload,
  previousStatus: string | null
): Promise<void> {
  await safeDispatch(
    "customer.status_changed",
    companyId,
    {
      event: "customer.status_changed",
      timestamp: new Date().toISOString(),
      customer,
      customerId: customer.id,
      previousStatus,
    },
    // Respect the trigger.config.toStatus filter — only fire workflows
    // that asked for this specific target status.
    (cfg) => {
      const want = cfg.toStatus;
      if (!want) return true; // no filter → match all
      return want === customer.status;
    }
  );
}

// ──────────────────────────────────────────────────────────────────────
// DEAL EVENTS
// ──────────────────────────────────────────────────────────────────────

interface DealPayload {
  id: string;
  title: string;
  value: number;
  currency: string;
  stage: string;
  customerId: string | null;
}

export async function dispatchDealCreated(
  companyId: string,
  deal: DealPayload,
  customer: CustomerPayload | null
): Promise<void> {
  await safeDispatch("deal.created", companyId, {
    event: "deal.created",
    timestamp: new Date().toISOString(),
    deal,
    customer,
    customerId: customer?.id ?? deal.customerId,
  });
}

export async function dispatchDealStageChanged(
  companyId: string,
  deal: DealPayload,
  customer: CustomerPayload | null,
  previousStage: string | null
): Promise<void> {
  // Fan out three events: the generic stage_changed, plus deal.won /
  // deal.lost when the new stage is terminal. This lets users build
  // workflows on either granularity without duplicating conditions.
  const basePayload = {
    timestamp: new Date().toISOString(),
    deal,
    customer,
    customerId: customer?.id ?? deal.customerId,
    previousStage,
  };

  await safeDispatch(
    "deal.stage_changed",
    companyId,
    { ...basePayload, event: "deal.stage_changed" },
    (cfg) => {
      const want = cfg.toStage;
      if (!want) return true;
      return want === deal.stage;
    }
  );

  if (deal.stage === "won") {
    await safeDispatch("deal.won", companyId, {
      ...basePayload,
      event: "deal.won",
    });
  } else if (deal.stage === "lost") {
    await safeDispatch("deal.lost", companyId, {
      ...basePayload,
      event: "deal.lost",
    });
  }
}

// ──────────────────────────────────────────────────────────────────────
// ACTIVITY EVENTS
// ──────────────────────────────────────────────────────────────────────

interface ActivityPayload {
  id: string;
  type: string;
  title: string;
  customerId: string | null;
}

export async function dispatchActivityCompleted(
  companyId: string,
  activity: ActivityPayload,
  customer: CustomerPayload | null
): Promise<void> {
  await safeDispatch(
    "activity.completed",
    companyId,
    {
      event: "activity.completed",
      timestamp: new Date().toISOString(),
      activity,
      customer,
      customerId: customer?.id ?? activity.customerId,
    },
    (cfg) => {
      const want = cfg.activityType;
      if (!want || want === "") return true;
      return want === activity.type;
    }
  );
}
