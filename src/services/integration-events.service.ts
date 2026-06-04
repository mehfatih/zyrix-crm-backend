// ============================================================================
// INTEGRATION EVENTS SERVICE
// ----------------------------------------------------------------------------
// Centralized health/audit log for integration flows (Shopify OAuth, sync…).
// Writes one row per lifecycle event into integration_events.
//
// DESIGN:
//  • Fire-and-forget — recordIntegrationEvent() swallows all errors so an
//    event-log write can NEVER break the primary flow (mirrors utils/audit).
//  • NEVER stores tokens/secrets/hmac. Callers pass a sanitized context.
//  • Uses $executeRawUnsafe (table created via raw SQL migration); reads use
//    $queryRawUnsafe for the Health Dashboard aggregations.
// ============================================================================

import { randomUUID } from "crypto";
import { prisma } from "../config/database";

export type IntegrationEventType =
  | "oauth_start"
  | "oauth_success"
  | "oauth_failure"
  | "token_refresh"
  | "token_refresh_failure"
  | "sync_start"
  | "sync_success"
  | "sync_failure"
  | "disconnect"
  | "api_failure"
  | "webhook_received"
  | "webhook_failed"
  | "whatsapp_message_in"
  | "whatsapp_message_out"
  | "whatsapp_send_failed"
  | "whatsapp_webhook_invalid"
  | "meta_lead_received"
  | "meta_lead_fetch_failed"
  | "meta_lead_webhook_invalid"
  | "google_ads_lead_received"
  | "google_ads_lead_invalid"
  | "meta_msg_in"
  | "meta_msg_out"
  | "meta_msg_send_failed"
  | "meta_msg_webhook_invalid"
  | "support_chat_started"
  | "support_ai_reply"
  | "support_ai_failed"
  | "support_escalated"
  // Google Workspace (Drive + Sheets) — Sprint 5
  | "google_export"
  | "google_import"
  | "google_save_to_drive"
  // Automation engine — Sprint 6
  | "workflow_run_completed"
  | "workflow_run_failed";

export interface RecordIntegrationEventInput {
  companyId?: string | null;
  platform?: string; // default 'shopify'
  eventType: IntegrationEventType;
  errorCode?: string | null;
  errorMessage?: string | null;
  requestContext?: Record<string, unknown>;
  durationMs?: number | null;
}

// Defense-in-depth: strip anything that looks like a secret before it lands
// in the jsonb context, even if a caller forgets.
const SECRET_KEYS = new Set([
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "token",
  "hmac",
  "secret",
  "client_secret",
  "apiSecret",
  "code",
  "password",
]);

function sanitizeContext(ctx: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!ctx) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (SECRET_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export async function recordIntegrationEvent(
  input: RecordIntegrationEventInput
): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO integration_events
         ("id", "companyId", "platform", "eventType", "errorCode", "errorMessage", "requestContext", "durationMs", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, NOW())`,
      randomUUID(),
      input.companyId ?? null,
      input.platform ?? "shopify",
      input.eventType,
      input.errorCode ?? null,
      input.errorMessage ?? null,
      JSON.stringify(sanitizeContext(input.requestContext)),
      input.durationMs ?? null
    );
  } catch (err) {
    // Intentional swallow — never break the primary flow. Surface in logs.
    console.error("[integration-events] write failed (non-fatal):", err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// HEALTH AGGREGATIONS — powers GET /api/integrations/shopify/health
// ──────────────────────────────────────────────────────────────────────
export interface EventCount {
  eventType: string;
  count: number;
}

/**
 * Count integration events by type for a company within the last `hours`
 * window. Returns a map keyed by eventType.
 */
export async function countEventsByType(
  companyId: string,
  platform: string,
  hours: number
): Promise<Record<string, number>> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT "eventType", COUNT(*)::int AS count
       FROM integration_events
      WHERE "companyId" = $1
        AND "platform" = $2
        AND "createdAt" >= NOW() - ($3 || ' hours')::interval
      GROUP BY "eventType"`,
    companyId,
    platform,
    String(hours)
  )) as Array<{ eventType: string; count: number }>;

  const map: Record<string, number> = {};
  for (const r of rows) map[r.eventType] = Number(r.count);
  return map;
}

/** Average sync_success durationMs for a company in the last `hours` window. */
export async function avgSyncDurationMs(
  companyId: string,
  platform: string,
  hours: number
): Promise<number | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT AVG("durationMs")::int AS avg
       FROM integration_events
      WHERE "companyId" = $1
        AND "platform" = $2
        AND "eventType" = 'sync_success'
        AND "durationMs" IS NOT NULL
        AND "createdAt" >= NOW() - ($3 || ' hours')::interval`,
    companyId,
    platform,
    String(hours)
  )) as Array<{ avg: number | null }>;
  return rows[0]?.avg ?? null;
}

/** Recent failure events (for a troubleshooting feed on the dashboard). */
export async function recentFailures(
  companyId: string,
  platform: string,
  limit: number
): Promise<
  Array<{
    eventType: string;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: Date;
  }>
> {
  return (await prisma.$queryRawUnsafe(
    `SELECT "eventType", "errorCode", "errorMessage", "createdAt"
       FROM integration_events
      WHERE "companyId" = $1
        AND "platform" = $2
        AND "eventType" LIKE '%failure%'
      ORDER BY "createdAt" DESC
      LIMIT $3`,
    companyId,
    platform,
    limit
  )) as Array<{
    eventType: string;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: Date;
  }>;
}
