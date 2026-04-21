// ============================================================================
// WORKFLOW ACTION RUNNERS
// ----------------------------------------------------------------------------
// Each action type in workflows-catalog.ts has a runner here. A runner is a
// pure async function: given (companyId, config, payload), do the thing and
// return { ok, output?, error? }. Runners never throw — they catch and
// return the error so the execution worker can log it cleanly and decide
// whether to retry.
// ============================================================================

import { prisma } from "../config/database";
import { sendEmail } from "./email.service";
import { sendViaMetaCloud } from "./whatsapp.service";
import { interpolate } from "./workflows.service";

export interface ActionResult {
  ok: boolean;
  output?: unknown;
  error?: string;
}

// ──────────────────────────────────────────────────────────────────────
// send_whatsapp_message
// ──────────────────────────────────────────────────────────────────────

async function runSendWhatsApp(
  companyId: string,
  config: Record<string, unknown>,
  payload: unknown
): Promise<ActionResult> {
  try {
    const toPhone = interpolate(String(config.toPhone ?? ""), payload).trim();
    const message = interpolate(String(config.message ?? ""), payload).trim();
    if (!toPhone) return { ok: false, error: "toPhone is empty after interpolation" };
    if (!message) return { ok: false, error: "message is empty after interpolation" };

    const result = await sendViaMetaCloud(companyId, toPhone, message);
    if (!result.success) {
      return {
        ok: false,
        error: result.error || "WhatsApp send failed",
        output: { messageId: result.messageId },
      };
    }
    return { ok: true, output: { messageId: result.messageId, toPhone } };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Unknown error" };
  }
}

// ──────────────────────────────────────────────────────────────────────
// send_email
// ──────────────────────────────────────────────────────────────────────

async function runSendEmail(
  _companyId: string,
  config: Record<string, unknown>,
  payload: unknown
): Promise<ActionResult> {
  try {
    const to = interpolate(String(config.toEmail ?? ""), payload).trim();
    const subject = interpolate(String(config.subject ?? ""), payload).trim();
    const body = interpolate(String(config.body ?? ""), payload);
    if (!to) return { ok: false, error: "toEmail is empty after interpolation" };
    if (!subject) return { ok: false, error: "subject is empty" };

    const sent = await sendEmail({ to, subject, html: body });
    if (!sent) {
      return { ok: false, error: "Email send returned false (check Resend config)" };
    }
    return { ok: true, output: { to, subject } };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Unknown error" };
  }
}

// ──────────────────────────────────────────────────────────────────────
// create_task — creates an Activity of type 'task'
// ──────────────────────────────────────────────────────────────────────

async function runCreateTask(
  companyId: string,
  config: Record<string, unknown>,
  payload: unknown,
  fallbackUserId: string
): Promise<ActionResult> {
  try {
    const title = interpolate(String(config.title ?? ""), payload).trim();
    if (!title) return { ok: false, error: "title is empty" };

    const assigneeId =
      typeof config.assigneeId === "string" && config.assigneeId.trim().length > 0
        ? config.assigneeId
        : fallbackUserId;

    const dueDays =
      typeof config.dueDays === "number" && config.dueDays > 0
        ? config.dueDays
        : null;
    const dueDate = dueDays
      ? new Date(Date.now() + dueDays * 24 * 60 * 60 * 1000)
      : null;

    // Resolve a customerId from the payload if one is present. Required
    // by the Activity schema.
    const customerId =
      (payload as any)?.customer?.id ?? (payload as any)?.customerId ?? null;

    if (!customerId) {
      return {
        ok: false,
        error: "No customer context in payload — task action needs a customer",
      };
    }

    const rows = (await prisma.$queryRawUnsafe(
      `INSERT INTO activities
         (id, "companyId", "customerId", "assignedToId", type, title,
          "dueDate", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, 'task', $4, $5, NOW(), NOW())
       RETURNING id`,
      companyId,
      customerId,
      assigneeId,
      title,
      dueDate
    )) as { id: string }[];
    return { ok: true, output: { activityId: rows[0]?.id } };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Unknown error" };
  }
}

// ──────────────────────────────────────────────────────────────────────
// update_deal_stage
// ──────────────────────────────────────────────────────────────────────

async function runUpdateDealStage(
  companyId: string,
  config: Record<string, unknown>,
  payload: unknown
): Promise<ActionResult> {
  try {
    const toStage = String(config.toStage ?? "").trim();
    if (!toStage) return { ok: false, error: "toStage is empty" };

    const dealId = (payload as any)?.deal?.id;
    if (!dealId) {
      return { ok: false, error: "No deal in payload — action requires a deal trigger" };
    }

    const rows = (await prisma.$queryRawUnsafe(
      `UPDATE deals SET stage = $1, "updatedAt" = NOW()
       WHERE id = $2 AND "companyId" = $3 RETURNING id, stage`,
      toStage,
      dealId,
      companyId
    )) as { id: string; stage: string }[];
    if (rows.length === 0) {
      return { ok: false, error: "Deal not found or not in this company" };
    }
    return { ok: true, output: { dealId, newStage: toStage } };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Unknown error" };
  }
}

// ──────────────────────────────────────────────────────────────────────
// update_customer_status
// ──────────────────────────────────────────────────────────────────────

async function runUpdateCustomerStatus(
  companyId: string,
  config: Record<string, unknown>,
  payload: unknown
): Promise<ActionResult> {
  try {
    const toStatus = String(config.toStatus ?? "").trim();
    if (!toStatus) return { ok: false, error: "toStatus is empty" };

    const customerId = (payload as any)?.customer?.id;
    if (!customerId) {
      return { ok: false, error: "No customer in payload" };
    }

    const rows = (await prisma.$queryRawUnsafe(
      `UPDATE customers SET status = $1, "updatedAt" = NOW()
       WHERE id = $2 AND "companyId" = $3 RETURNING id, status`,
      toStatus,
      customerId,
      companyId
    )) as { id: string; status: string }[];
    if (rows.length === 0) {
      return { ok: false, error: "Customer not found" };
    }
    return { ok: true, output: { customerId, newStatus: toStatus } };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Unknown error" };
  }
}

// ──────────────────────────────────────────────────────────────────────
// add_tag — upsert tag, link to customer
// ──────────────────────────────────────────────────────────────────────

async function runAddTag(
  companyId: string,
  config: Record<string, unknown>,
  payload: unknown
): Promise<ActionResult> {
  try {
    const tagName = String(config.tagName ?? "").trim();
    if (!tagName) return { ok: false, error: "tagName is empty" };

    const customerId = (payload as any)?.customer?.id;
    if (!customerId) {
      return { ok: false, error: "No customer in payload" };
    }

    // Upsert the tag
    const tagRows = (await prisma.$queryRawUnsafe(
      `INSERT INTO tags (id, "companyId", name, "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, NOW(), NOW())
       ON CONFLICT ("companyId", name) DO UPDATE SET "updatedAt" = NOW()
       RETURNING id`,
      companyId,
      tagName
    )) as { id: string }[];
    const tagId = tagRows[0]?.id;
    if (!tagId) return { ok: false, error: "Could not upsert tag" };

    // Link customer_tags — unique composite
    await prisma.$executeRawUnsafe(
      `INSERT INTO customer_tags ("customerId", "tagId")
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      customerId,
      tagId
    );

    return { ok: true, output: { tagId, customerId, tagName } };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Unknown error" };
  }
}

// ──────────────────────────────────────────────────────────────────────
// call_webhook — outbound HTTP
// ──────────────────────────────────────────────────────────────────────

async function runCallWebhook(
  _companyId: string,
  config: Record<string, unknown>,
  payload: unknown
): Promise<ActionResult> {
  try {
    const rawUrl = String(config.url ?? "").trim();
    const url = interpolate(rawUrl, payload).trim();
    if (!url || !url.startsWith("http")) {
      return { ok: false, error: "url is invalid or missing" };
    }
    const method = String(config.method ?? "POST").toUpperCase();
    if (!["POST", "PUT", "PATCH"].includes(method)) {
      return { ok: false, error: `unsupported method ${method}` };
    }
    const authHeader =
      typeof config.authHeader === "string" && config.authHeader.trim().length > 0
        ? interpolate(config.authHeader, payload)
        : null;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);

    try {
      const resp = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await resp.text();
      if (!resp.ok) {
        return {
          ok: false,
          error: `HTTP ${resp.status}: ${text.slice(0, 200)}`,
          output: { status: resp.status },
        };
      }
      return {
        ok: true,
        output: { status: resp.status, responseSnippet: text.slice(0, 500) },
      };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (e: any) {
    if (e?.name === "AbortError") {
      return { ok: false, error: "Webhook timed out after 10s" };
    }
    return { ok: false, error: e?.message || "Unknown error" };
  }
}

// ──────────────────────────────────────────────────────────────────────
// Dispatcher
// ──────────────────────────────────────────────────────────────────────

export async function runAction(
  type: string,
  companyId: string,
  config: Record<string, unknown>,
  payload: unknown,
  fallbackUserId: string
): Promise<ActionResult> {
  switch (type) {
    case "send_whatsapp_message":
      return runSendWhatsApp(companyId, config, payload);
    case "send_email":
      return runSendEmail(companyId, config, payload);
    case "create_task":
      return runCreateTask(companyId, config, payload, fallbackUserId);
    case "update_deal_stage":
      return runUpdateDealStage(companyId, config, payload);
    case "update_customer_status":
      return runUpdateCustomerStatus(companyId, config, payload);
    case "add_tag":
      return runAddTag(companyId, config, payload);
    case "call_webhook":
      return runCallWebhook(companyId, config, payload);
    default:
      return { ok: false, error: `Unknown action type: ${type}` };
  }
}
