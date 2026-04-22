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
import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../config/env";

const genAI = env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(env.GEMINI_API_KEY)
  : null;

// ──────────────────────────────────────────────────────────────────────
// AI helpers — all use gemini-2.0-flash per handoff
// ──────────────────────────────────────────────────────────────────────

async function geminiText(prompt: string): Promise<string> {
  if (!genAI) throw new Error("GEMINI_API_KEY is not configured");
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
  const result = await model.generateContent(prompt);
  return result.response.text().trim();
}

async function runAiGenerateEmail(
  _companyId: string,
  config: Record<string, unknown>,
  payload: unknown
): Promise<ActionResult> {
  try {
    const purpose = interpolate(String(config.purpose ?? ""), payload);
    const tone = String(config.tone ?? "professional");
    const locale = String(config.locale ?? "en");
    const context = JSON.stringify(payload ?? {}, null, 2).slice(0, 4000);
    const prompt = `You are drafting a ${tone} email in ${locale}. Purpose: ${purpose}
Context (from the CRM event that triggered this workflow):
${context}

Return strict JSON: {"subject": "...", "bodyHtml": "...", "bodyText": "..."}`;
    const raw = await geminiText(prompt);
    // Strip code fences if Gemini wraps JSON
    const jsonText = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "");
    let parsed: { subject?: string; bodyHtml?: string; bodyText?: string };
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return { ok: false, error: "AI returned non-JSON", output: { raw } };
    }
    return { ok: true, output: parsed };
  } catch (e: any) {
    return { ok: false, error: e?.message || "AI generate failed" };
  }
}

async function runAiSummarize(
  _companyId: string,
  config: Record<string, unknown>,
  payload: unknown
): Promise<ActionResult> {
  try {
    const text = interpolate(String(config.text ?? ""), payload);
    const maxWords = Number(config.maxWords ?? 60);
    const prompt = `Summarize in ${maxWords} words or fewer. Preserve key facts, numbers, names.

TEXT:
${text}

SUMMARY:`;
    const summary = await geminiText(prompt);
    return { ok: true, output: { summary } };
  } catch (e: any) {
    return { ok: false, error: e?.message || "AI summarize failed" };
  }
}

async function runAiCategorize(
  _companyId: string,
  config: Record<string, unknown>,
  payload: unknown
): Promise<ActionResult> {
  try {
    const text = interpolate(String(config.text ?? ""), payload);
    const categories = Array.isArray(config.categories)
      ? (config.categories as string[])
      : [];
    if (categories.length === 0) {
      return { ok: false, error: "categories list is empty" };
    }
    const prompt = `Pick exactly one category for the text. Reply with just the category name, no prose.
Categories: ${categories.join(", ")}

TEXT:
${text}

CATEGORY:`;
    const picked = (await geminiText(prompt)).split("\n")[0].trim();
    const normalized = categories.find(
      (c) => c.toLowerCase() === picked.toLowerCase()
    );
    return {
      ok: true,
      output: { category: normalized ?? picked, raw: picked },
    };
  } catch (e: any) {
    return { ok: false, error: e?.message || "AI categorize failed" };
  }
}

async function runAiTranslate(
  _companyId: string,
  config: Record<string, unknown>,
  payload: unknown
): Promise<ActionResult> {
  try {
    const text = interpolate(String(config.text ?? ""), payload);
    const target = String(config.targetLocale ?? "en");
    const prompt = `Translate the following text to ${target}. Preserve tone, numbers, and proper nouns. Return only the translation.

TEXT:
${text}

TRANSLATION:`;
    const translation = await geminiText(prompt);
    return { ok: true, output: { translation, target } };
  } catch (e: any) {
    return { ok: false, error: e?.message || "AI translate failed" };
  }
}

async function runSendNotification(
  companyId: string,
  config: Record<string, unknown>,
  payload: unknown
): Promise<ActionResult> {
  try {
    const userId = interpolate(String(config.userId ?? ""), payload).trim();
    const title = interpolate(String(config.title ?? ""), payload).trim();
    const message = interpolate(
      String(config.message ?? ""),
      payload
    ).trim();
    if (!userId) return { ok: false, error: "userId is empty" };
    if (!title) return { ok: false, error: "title is empty" };
    await prisma.notification.create({
      data: {
        companyId,
        userId,
        kind: "workflow",
        title,
        body: message || null,
      } as any,
    });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || "send_notification failed" };
  }
}

async function runUpdateField(
  companyId: string,
  config: Record<string, unknown>,
  payload: unknown
): Promise<ActionResult> {
  try {
    const entity = String(config.entity ?? "");
    const entityIdRaw = interpolate(String(config.entityId ?? ""), payload);
    const field = String(config.field ?? "");
    const valueRaw = config.value;
    const value =
      typeof valueRaw === "string" ? interpolate(valueRaw, payload) : valueRaw;
    if (!entity || !entityIdRaw || !field) {
      return { ok: false, error: "entity, entityId, and field are required" };
    }
    const where = { id: entityIdRaw, companyId };
    const data = { [field]: value } as any;
    switch (entity) {
      case "customer":
        await prisma.customer.updateMany({ where, data });
        break;
      case "deal":
        await prisma.deal.updateMany({ where, data });
        break;
      case "quote":
        await prisma.quote.updateMany({ where, data });
        break;
      case "contract":
        await prisma.contract.updateMany({ where, data });
        break;
      default:
        return { ok: false, error: `Unsupported entity: ${entity}` };
    }
    return { ok: true, output: { entity, entityId: entityIdRaw, field } };
  } catch (e: any) {
    return { ok: false, error: e?.message || "update_field failed" };
  }
}

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
    case "webhook_call":
      return runCallWebhook(companyId, config, payload);
    // ── P10 AI-native step types ───────────────────────────────────
    case "ai_generate_email":
      return runAiGenerateEmail(companyId, config, payload);
    case "ai_summarize":
      return runAiSummarize(companyId, config, payload);
    case "ai_categorize":
      return runAiCategorize(companyId, config, payload);
    case "ai_translate":
      return runAiTranslate(companyId, config, payload);
    case "send_notification":
      return runSendNotification(companyId, config, payload);
    case "update_field":
      return runUpdateField(companyId, config, payload);
    default:
      return { ok: false, error: `Unknown action type: ${type}` };
  }
}
