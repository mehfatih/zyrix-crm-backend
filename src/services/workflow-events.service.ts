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
// LEAD CAPTURE EVENTS (external sources — e.g. Meta Lead Ads)
// ──────────────────────────────────────────────────────────────────────

export async function dispatchLeadCaptured(
  companyId: string,
  customer: CustomerPayload,
  deal: DealPayload | null,
  source: string | null
): Promise<void> {
  await safeDispatch(
    "lead.captured",
    companyId,
    {
      event: "lead.captured",
      timestamp: new Date().toISOString(),
      customer,
      deal,
      customerId: customer.id,
      source,
    },
    // Optional source filter (substring match, case-insensitive).
    (cfg) => {
      const want = typeof cfg.source === "string" ? cfg.source.trim() : "";
      if (!want) return true;
      return (source ?? "").toLowerCase().includes(want.toLowerCase());
    }
  );
}

// ──────────────────────────────────────────────────────────────────────
// TAG EVENTS
// ──────────────────────────────────────────────────────────────────────

export async function dispatchTagAdded(
  companyId: string,
  customer: { id: string; fullName: string },
  tag: { id: string; name: string }
): Promise<void> {
  await safeDispatch(
    "tag.added",
    companyId,
    {
      event: "tag.added",
      timestamp: new Date().toISOString(),
      customer,
      customerId: customer.id,
      tag,
    },
    // Optional tagName filter — exact (case-insensitive) match.
    (cfg) => {
      const want = typeof cfg.tagName === "string" ? cfg.tagName.trim() : "";
      if (!want) return true;
      return want.toLowerCase() === tag.name.toLowerCase();
    }
  );
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

// ──────────────────────────────────────────────────────────────────────
// PRODUCT EVENTS (Sprint 8)
// ──────────────────────────────────────────────────────────────────────

interface LowStockPayload {
  id: string;
  name: string;
  sku: string | null;
  location: string;
  qty: number;
  lowStockThreshold: number;
}

/**
 * Fired by the daily low-stock cron when a product's on-hand level drops to
 * or below its threshold. Merchants can build "notify owner + create purchase
 * task" automations on the `product.low_stock` trigger.
 */
export async function dispatchProductLowStock(
  companyId: string,
  product: LowStockPayload
): Promise<void> {
  await safeDispatch("product.low_stock", companyId, {
    event: "product.low_stock",
    timestamp: new Date().toISOString(),
    product,
    productId: product.id,
  });
}

// ──────────────────────────────────────────────────────────────────────
// QUOTE EVENTS (Sprint 9 — CPQ)
// ──────────────────────────────────────────────────────────────────────

interface QuotePayload {
  id: string;
  quoteNumber: string;
  title: string;
  status: string;
  total: number;
  currency: string;
  customerId: string;
  dealId: string | null;
}

/** Fired the first time a customer opens the public quote link. */
export async function dispatchQuoteViewed(
  companyId: string,
  quote: QuotePayload
): Promise<void> {
  await safeDispatch("quote.viewed", companyId, {
    event: "quote.viewed",
    timestamp: new Date().toISOString(),
    quote,
    quoteId: quote.id,
    customerId: quote.customerId,
    dealId: quote.dealId,
  });
}

/** Fired when a customer accepts the quote from the public page. Merchants
 *  automate: move the deal to Won, deduct stock, send a thank-you message. */
export async function dispatchQuoteAccepted(
  companyId: string,
  quote: QuotePayload
): Promise<void> {
  await safeDispatch("quote.accepted", companyId, {
    event: "quote.accepted",
    timestamp: new Date().toISOString(),
    quote,
    quoteId: quote.id,
    customerId: quote.customerId,
    dealId: quote.dealId,
  });
}

/** Fired when a customer e-signs the quote on the public page (Sprint 15A).
 *  Signing implies acceptance, but we emit the more specific quote.signed
 *  event ONLY (not quote.accepted) so automations don't double-fire. */
export async function dispatchQuoteSigned(
  companyId: string,
  quote: QuotePayload,
  signer: { signerName: string; signedAtUtc: string }
): Promise<void> {
  await safeDispatch("quote.signed", companyId, {
    event: "quote.signed",
    timestamp: new Date().toISOString(),
    quote,
    quoteId: quote.id,
    customerId: quote.customerId,
    dealId: quote.dealId,
    signerName: signer.signerName,
    signedAtUtc: signer.signedAtUtc,
  });
}

// ──────────────────────────────────────────────────────────────────────
// EMAIL EVENTS (Sprint 10)
// ──────────────────────────────────────────────────────────────────────

interface EmailEventPayload {
  emailId: string;
  customerId: string | null;
  openCount?: number;
  firstOpen?: boolean;
  replied?: boolean; // always false this sprint — reply detection deferred
  url?: string;
}

// Emitted on every genuinely-new open (deduped). `openCount` + `firstOpen` let
// merchants build either "first open" (openCount eq 1 / firstOpen isTrue) or
// "opened ≥ N times" (openCount gte N) conditions on the existing engine.
export async function dispatchEmailOpened(companyId: string, p: EmailEventPayload): Promise<void> {
  await safeDispatch("email.opened", companyId, {
    event: "email.opened",
    timestamp: new Date().toISOString(),
    ...p,
    replied: false,
  });
}

export async function dispatchEmailClicked(companyId: string, p: EmailEventPayload): Promise<void> {
  await safeDispatch("email.clicked", companyId, {
    event: "email.clicked",
    timestamp: new Date().toISOString(),
    ...p,
    replied: false,
  });
}

export async function dispatchEmailBounced(companyId: string, p: EmailEventPayload): Promise<void> {
  await safeDispatch("email.bounced", companyId, {
    event: "email.bounced",
    timestamp: new Date().toISOString(),
    ...p,
  });
}

// Sprint 15C — fired when a customer replies to a tracked email (inbound webhook).
export async function dispatchEmailReplied(
  companyId: string,
  p: { emailId: string; customerId: string | null; replyPreview: string; repliedAt: string }
): Promise<void> {
  await safeDispatch("email.replied", companyId, {
    event: "email.replied",
    timestamp: new Date().toISOString(),
    emailId: p.emailId,
    customerId: p.customerId,
    replyPreview: p.replyPreview,
    repliedAt: p.repliedAt,
    replied: true,
  });
}

// ──────────────────────────────────────────────────────────────────────
// CADENCE EVENTS (Sprint 11)
// ──────────────────────────────────────────────────────────────────────
export async function dispatchCadenceExited(
  companyId: string,
  p: { cadenceId: string; contactId: string; reason: string }
): Promise<void> {
  await safeDispatch("cadence.exited", companyId, {
    event: "cadence.exited",
    timestamp: new Date().toISOString(),
    ...p,
    customerId: p.contactId,
  });
}

// ──────────────────────────────────────────────────────────────────────
// FORM EVENTS (Sprint 12) — optional formId config filter
// ──────────────────────────────────────────────────────────────────────
export async function dispatchFormSubmitted(
  companyId: string,
  contact: { id: string; fullName: string; email: string | null; phone: string | null },
  dealId: string | null,
  form: { id: string; name: string }
): Promise<void> {
  await safeDispatch(
    "form.submitted",
    companyId,
    {
      event: "form.submitted",
      timestamp: new Date().toISOString(),
      customer: contact,
      customerId: contact.id,
      dealId,
      form,
    },
    (cfg) => !cfg.formId || cfg.formId === form.id
  );
}
