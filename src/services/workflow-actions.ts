// ============================================================================
// WORKFLOW ACTION RUNNERS
// ----------------------------------------------------------------------------
// Each action type in workflows-catalog.ts has a runner here. A runner is a
// pure async function: given (companyId, config, payload), do the thing and
// return { ok, output?, error? }. Runners never throw — they catch and
// return the error so the execution worker can log it cleanly and decide
// whether to retry.
// ============================================================================

import { createHmac } from "crypto";
import { prisma } from "../config/database";
import { sendEmail } from "./email.service";
import { sendTrackedEmail } from "./email-tracking.service";
import { sendViaMetaCloud, sendTemplateByPhone } from "./whatsapp.service";
import { bumpStepStat } from "./cadence.service";

// Cadence step metadata the compiler stamps onto each step's action config.
function cadenceMeta(config: Record<string, unknown>): { cadenceId: string; stepIndex: number } | null {
  const cadenceId = config._cadenceId;
  const stepIndex = config._stepIndex;
  if (typeof cadenceId === "string" && typeof stepIndex === "number") {
    return { cadenceId, stepIndex };
  }
  return null;
}
import { createTask } from "./task.service";
import { interpolate } from "./workflows.service";
import {
  getRecipe,
  executeRecipeConfig,
  type RecipeType,
} from "./action-recipes.service";
import { getCompanyAIContext } from "./company-ai-profile.service";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../config/env";

const genAI = env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(env.GEMINI_API_KEY)
  : null;

// ──────────────────────────────────────────────────────────────────────
// AI helpers — all use gemini-2.5-flash per handoff
// ──────────────────────────────────────────────────────────────────────

async function geminiText(prompt: string): Promise<string> {
  if (!genAI) throw new Error("GEMINI_API_KEY is not configured");
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const result = await model.generateContent(prompt);
  return result.response.text().trim();
}

async function runAiGenerateEmail(
  companyId: string,
  config: Record<string, unknown>,
  payload: unknown
): Promise<ActionResult> {
  try {
    const purpose = interpolate(String(config.purpose ?? ""), payload);
    const tone = String(config.tone ?? "professional");
    const locale = String(config.locale ?? "en");
    const context = JSON.stringify(payload ?? {}, null, 2).slice(0, 4000);
    // AI Studio: prepend the company's AI profile so automated drafts match the
    // merchant's voice (null-safe → no-op).
    const aiCtx = await getCompanyAIContext(companyId);
    const prompt = `${aiCtx ? aiCtx + "\n\n" : ""}You are drafting a ${tone} email in ${locale}. Purpose: ${purpose}
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
  payload: unknown,
  fallbackUserId: string
): Promise<ActionResult> {
  try {
    // Blank recipient → the workflow's creator (per the builder hint).
    const userId =
      interpolate(String(config.userId ?? ""), payload).trim() || fallbackUserId;
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

    // Spec: notify = in-app + email. Best-effort — a missing email or a
    // Resend hiccup logs 'skipped' but never fails the run.
    let emailed = false;
    try {
      const rows = (await prisma.$queryRawUnsafe(
        `SELECT email FROM users WHERE id = $1 AND "companyId" = $2 LIMIT 1`,
        userId,
        companyId
      )) as { email: string | null }[];
      const to = rows[0]?.email;
      if (to) {
        emailed = await sendEmail({
          to,
          subject: title,
          html: `<p>${message || title}</p>`,
          text: message || title,
        });
      }
    } catch {
      /* email is best-effort; in-app notification already succeeded */
    }
    return { ok: true, output: { emailed } };
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
  // false = deterministic failure (bad config / missing payload context /
  // not-found reference) — the worker dead-letters instead of retrying.
  // Omitted/true = transient (network/API/DB), eligible for backoff retry.
  retryable?: boolean;
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
// send_whatsapp_template — approved template by phone (cadence WhatsApp steps)
// ──────────────────────────────────────────────────────────────────────

async function runSendWhatsAppTemplate(
  companyId: string,
  config: Record<string, unknown>,
  payload: unknown
): Promise<ActionResult> {
  try {
    const toPhone = interpolate(String(config.toPhone ?? ""), payload).trim();
    const templateName = String(config.templateName ?? "").trim();
    const lang = String(config.templateLang ?? "en").trim() || "en";
    if (!toPhone) return { ok: false, error: "toPhone is empty after interpolation" };
    if (!templateName) return { ok: false, error: "templateName is required" };
    const r = await sendTemplateByPhone(companyId, toPhone, templateName, lang);
    if (!r.success) {
      return { ok: false, error: r.error || "WhatsApp template send failed", output: { messageId: r.messageId } };
    }
    const cad = cadenceMeta(config);
    if (cad) void bumpStepStat(cad.cadenceId, cad.stepIndex, "sent");
    return { ok: true, output: { messageId: r.messageId, toPhone, templateName } };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Unknown error" };
  }
}

// ──────────────────────────────────────────────────────────────────────
// send_email
// ──────────────────────────────────────────────────────────────────────

async function runSendEmail(
  companyId: string,
  config: Record<string, unknown>,
  payload: unknown
): Promise<ActionResult> {
  try {
    const to = interpolate(String(config.toEmail ?? ""), payload).trim();
    const subject = interpolate(String(config.subject ?? ""), payload).trim();
    const body = interpolate(String(config.body ?? ""), payload);
    if (!to) return { ok: false, error: "toEmail is empty after interpolation" };
    if (!subject) return { ok: false, error: "subject is empty" };

    // Tracked send (Sprint 10) — this is a CRM→contact automation email.
    const p = payload as { customerId?: string; contactId?: string } | null;
    const cad = cadenceMeta(config);
    const r = await sendTrackedEmail({
      companyId,
      contactId: p?.customerId ?? p?.contactId ?? null,
      to,
      subject,
      html: body,
      cadenceId: cad?.cadenceId ?? null,
      cadenceStepIndex: cad?.stepIndex ?? null,
    });
    if (!r.ok) {
      return { ok: false, error: "Email send returned false (check Resend config)" };
    }
    if (cad) void bumpStepStat(cad.cadenceId, cad.stepIndex, "sent");
    return { ok: true, output: { to, subject } };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Unknown error" };
  }
}

// ──────────────────────────────────────────────────────────────────────
// create_task — creates a real Task via task.service (tasks table)
// ----------------------------------------------------------------------------
// Reuses task.service.createTask so the task lands in the `tasks` table with
// the correct columns and shows up in the Tasks UI. (The old hand-rolled
// INSERT into `activities` referenced a non-existent "assignedToId" column →
// Postgres 42703, failing every create_task run.) customerId/dealId are
// optional now — a schedule/idle trigger can create an unattached task.
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

    const assigneeRaw =
      typeof config.assigneeId === "string"
        ? interpolate(config.assigneeId, payload).trim()
        : "";
    const assignedToId = assigneeRaw.length > 0 ? assigneeRaw : fallbackUserId;

    const dueDays =
      typeof config.dueDays === "number" && config.dueDays > 0
        ? config.dueDays
        : null;
    const dueDate = dueDays
      ? new Date(Date.now() + dueDays * 24 * 60 * 60 * 1000)
      : null;

    const customerId =
      (payload as any)?.customer?.id ?? (payload as any)?.customerId ?? null;
    const dealId = (payload as any)?.deal?.id ?? null;

    const task = await createTask(companyId, fallbackUserId, {
      title,
      assignedToId,
      customerId,
      dealId,
      dueDate,
    });
    const cad = cadenceMeta(config);
    if (cad) void bumpStepStat(cad.cadenceId, cad.stepIndex, "sent");
    return { ok: true, output: { taskId: task.id } };
  } catch (e: any) {
    return { ok: false, error: e?.message || "create_task failed" };
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
// assign_owner — fixed / round-robin / territory assignment
// ----------------------------------------------------------------------------
// Sets ownerId on the triggering customer and/or deal. Round-robin uses an
// ATOMIC pointer bump so concurrent runs (and AC #1's "second lead → other
// user") distribute correctly even under the multi-instance worker:
//   • territory pool → UPDATE territories SET rrIndex = rrIndex+1 RETURNING
//   • company pool   → INSERT ... ON CONFLICT DO UPDATE SET idx = idx+1 RETURNING
// ──────────────────────────────────────────────────────────────────────

/** Active users for a company, stable order (oldest first) for predictable RR. */
async function getActiveCompanyUsers(companyId: string): Promise<string[]> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id FROM users
     WHERE "companyId" = $1 AND status = 'active'
     ORDER BY "createdAt" ASC, id ASC`,
    companyId
  )) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * Atomically advance the company-level RR pointer for a scope and return the
 * zero-based slot to use. First call returns 0, then 1, 2, … (wrap handled by
 * the caller via modulo over the pool size).
 */
async function nextCompanyRrSlot(
  companyId: string,
  scope: string
): Promise<number> {
  const rows = (await prisma.$queryRawUnsafe(
    `INSERT INTO automation_rr_pointers ("companyId", scope, idx, "updatedAt")
     VALUES ($1, $2, 0, NOW())
     ON CONFLICT ("companyId", scope)
       DO UPDATE SET idx = automation_rr_pointers.idx + 1, "updatedAt" = NOW()
     RETURNING idx`,
    companyId,
    scope
  )) as { idx: number }[];
  return Number(rows[0]?.idx ?? 0);
}

/** Find the first territory whose criteria match a customer row. */
async function matchTerritoryForCustomer(
  companyId: string,
  customerId: string
): Promise<{ id: string; ownerId: string | null; memberUserIds: string[] } | null> {
  const custRows = (await prisma.$queryRawUnsafe(
    `SELECT country, city, "companyName", source FROM customers
     WHERE id = $1 AND "companyId" = $2 LIMIT 1`,
    customerId,
    companyId
  )) as {
    country: string | null;
    city: string | null;
    companyName: string | null;
    source: string | null;
  }[];
  if (custRows.length === 0) return null;
  const c = custRows[0];

  const terrs = (await prisma.$queryRawUnsafe(
    `SELECT id, criteria, "ownerId", "memberUserIds" FROM territories
     WHERE "companyId" = $1 ORDER BY name ASC`,
    companyId
  )) as {
    id: string;
    criteria: any;
    ownerId: string | null;
    memberUserIds: any;
  }[];

  for (const t of terrs) {
    const cr = (typeof t.criteria === "string" ? JSON.parse(t.criteria) : t.criteria) || {};
    const matches =
      (!cr.country ||
        (Array.isArray(cr.country) && cr.country.includes(c.country))) &&
      (!cr.city || (Array.isArray(cr.city) && cr.city.includes(c.city))) &&
      (!cr.sourceContains ||
        (c.source ?? "")
          .toLowerCase()
          .includes(String(cr.sourceContains).toLowerCase())) &&
      (!cr.companyNameContains ||
        (c.companyName ?? "")
          .toLowerCase()
          .includes(String(cr.companyNameContains).toLowerCase()));
    if (matches) {
      const members =
        typeof t.memberUserIds === "string"
          ? JSON.parse(t.memberUserIds)
          : t.memberUserIds;
      return {
        id: t.id,
        ownerId: t.ownerId,
        memberUserIds: Array.isArray(members) ? members : [],
      };
    }
  }
  return null;
}

/** Round-robin over a territory's member pool via an atomic rrIndex bump. */
async function nextTerritoryMember(
  territoryId: string,
  members: string[]
): Promise<string | null> {
  if (members.length === 0) return null;
  const rows = (await prisma.$queryRawUnsafe(
    `UPDATE territories SET "rrIndex" = "rrIndex" + 1, "updatedAt" = NOW()
     WHERE id = $1 RETURNING "rrIndex"`,
    territoryId
  )) as { rrIndex: number }[];
  // rrIndex is post-increment; subtract 1 so the first assignment lands on member[0].
  const slot = ((Number(rows[0]?.rrIndex ?? 1) - 1) % members.length + members.length) %
    members.length;
  return members[slot];
}

async function runAssignOwner(
  companyId: string,
  config: Record<string, unknown>,
  payload: unknown,
  fallbackUserId: string
): Promise<ActionResult> {
  try {
    const mode = String(config.mode ?? "").trim();
    const customerId = (payload as any)?.customer?.id ?? (payload as any)?.customerId ?? null;
    const dealId = (payload as any)?.deal?.id ?? null;
    if (!customerId && !dealId) {
      return { ok: false, error: "No customer or deal in payload to assign" };
    }

    let assignee: string | null = null;
    let detail: Record<string, unknown> = { mode };

    if (mode === "fixed") {
      // Blank → the workflow's creator (per the builder hint).
      assignee = String(config.userId ?? "").trim() || fallbackUserId || null;
      if (!assignee) return { ok: false, error: "fixed mode requires userId" };
    } else if (mode === "round_robin") {
      const territoryId = String(config.territoryId ?? "").trim();
      if (territoryId) {
        const terrRows = (await prisma.$queryRawUnsafe(
          `SELECT "memberUserIds" FROM territories WHERE id = $1 AND "companyId" = $2 LIMIT 1`,
          territoryId,
          companyId
        )) as { memberUserIds: any }[];
        if (terrRows.length === 0) {
          return { ok: false, error: "territory not found" };
        }
        const members =
          typeof terrRows[0].memberUserIds === "string"
            ? JSON.parse(terrRows[0].memberUserIds)
            : terrRows[0].memberUserIds;
        const pool = Array.isArray(members) ? members : [];
        assignee = await nextTerritoryMember(territoryId, pool);
        detail.territoryId = territoryId;
        if (!assignee) {
          return { ok: false, error: "territory has no members to round-robin" };
        }
      } else {
        const users = await getActiveCompanyUsers(companyId);
        if (users.length === 0) {
          return { ok: false, error: "no active users to round-robin" };
        }
        const slot = await nextCompanyRrSlot(companyId, "company");
        assignee = users[slot % users.length];
      }
    } else if (mode === "territory") {
      if (!customerId) {
        return { ok: false, error: "territory mode needs a customer in the payload" };
      }
      const matched = await matchTerritoryForCustomer(companyId, customerId);
      if (!matched) {
        return { ok: false, error: "no territory matched the customer", output: { mode } };
      }
      detail.territoryId = matched.id;
      // Prefer the territory's default owner; otherwise round-robin its members.
      assignee = matched.ownerId
        ? matched.ownerId
        : await nextTerritoryMember(matched.id, matched.memberUserIds);
      if (!assignee) {
        return { ok: false, error: "matched territory has neither owner nor members" };
      }
    } else {
      return { ok: false, error: `unknown assign mode: ${mode}` };
    }

    const updated: { customer: boolean; deal: boolean } = { customer: false, deal: false };
    if (customerId) {
      const r = (await prisma.$queryRawUnsafe(
        `UPDATE customers SET "ownerId" = $1, "updatedAt" = NOW()
         WHERE id = $2 AND "companyId" = $3 RETURNING id`,
        assignee,
        customerId,
        companyId
      )) as { id: string }[];
      updated.customer = r.length > 0;
    }
    if (dealId) {
      const r = (await prisma.$queryRawUnsafe(
        `UPDATE deals SET "ownerId" = $1, "updatedAt" = NOW()
         WHERE id = $2 AND "companyId" = $3 RETURNING id`,
        assignee,
        dealId,
        companyId
      )) as { id: string }[];
      updated.deal = r.length > 0;
    }

    return { ok: true, output: { assignedUserId: assignee, ...detail, updated } };
  } catch (e: any) {
    return { ok: false, error: e?.message || "assign_owner failed" };
  }
}

// ──────────────────────────────────────────────────────────────────────
// webhook_out — signed outbound POST with HMAC-SHA256 + up to 2 retries
// ──────────────────────────────────────────────────────────────────────

async function runWebhookOut(
  _companyId: string,
  config: Record<string, unknown>,
  payload: unknown
): Promise<ActionResult> {
  const url = interpolate(String(config.url ?? ""), payload).trim();
  const secret = String(config.secret ?? "");
  if (!url || !url.startsWith("http")) {
    return { ok: false, error: "url is invalid or missing" };
  }
  if (!secret) return { ok: false, error: "signing secret is required" };

  const body = JSON.stringify(payload ?? {});
  const signature = createHmac("sha256", secret).update(body).digest("hex");

  // 1 initial attempt + 2 retries = 3 total.
  const MAX_TRIES = 3;
  let lastError = "unknown error";
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Zyrix-Signature": `sha256=${signature}`,
          "X-Zyrix-Delivery-Attempt": String(attempt),
        },
        body,
        signal: controller.signal,
      });
      const text = await resp.text();
      if (resp.ok) {
        return {
          ok: true,
          output: { status: resp.status, attempt, responseSnippet: text.slice(0, 500) },
        };
      }
      lastError = `HTTP ${resp.status}: ${text.slice(0, 200)}`;
    } catch (e: any) {
      lastError = e?.name === "AbortError" ? "timed out after 10s" : e?.message || "request failed";
    } finally {
      clearTimeout(timeoutId);
    }
    // Linear backoff between retries (0.5s, 1s) — short, since the worker
    // slot is held for the duration.
    if (attempt < MAX_TRIES) {
      await new Promise((r) => setTimeout(r, attempt * 500));
    }
  }
  return { ok: false, error: `webhook_out failed after ${MAX_TRIES} attempts: ${lastError}` };
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
  // ── Sprint 13 Custom Actions: recipe-backed steps (type = "recipe:{id}") ──
  if (type.startsWith("recipe:")) {
    return runRecipeStep(companyId, type.slice("recipe:".length), payload);
  }
  switch (type) {
    case "send_whatsapp_message":
      return runSendWhatsApp(companyId, config, payload);
    case "send_whatsapp_template":
      return runSendWhatsAppTemplate(companyId, config, payload);
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
    case "assign_owner":
      return runAssignOwner(companyId, config, payload, fallbackUserId);
    case "webhook_out":
      return runWebhookOut(companyId, config, payload);
    case "call_webhook":
    case "webhook_call":
      return runCallWebhook(companyId, config, payload);
    case "wait":
      // Wait steps are intercepted by the worker before reaching here; this
      // defensive no-op keeps a stray wait from failing a run.
      return { ok: true, output: { note: "wait handled by scheduler" } };
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
      return runSendNotification(companyId, config, payload, fallbackUserId);
    case "update_field":
      return runUpdateField(companyId, config, payload);
    default:
      return { ok: false, error: `Unknown action type: ${type}` };
  }
}

// Load a recipe by id (tenant-scoped) and execute it. A disabled recipe logs a
// clean "skipped" instead of failing the run; a deleted/foreign recipe fails.
async function runRecipeStep(
  companyId: string,
  recipeId: string,
  payload: unknown
): Promise<ActionResult> {
  const recipe = await getRecipe(companyId, recipeId);
  if (!recipe) return { ok: false, error: `recipe ${recipeId} not found` };
  if (!recipe.enabled) {
    return { ok: true, output: { skipped: true, reason: "recipe disabled" } };
  }
  return executeRecipeConfig(
    companyId,
    recipe.type as RecipeType,
    recipe.config,
    payload,
    { dryRun: false }
  );
}
