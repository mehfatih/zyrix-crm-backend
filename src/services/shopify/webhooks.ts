// ============================================================================
// SHOPIFY WEBHOOKS — real-time event processing
// ----------------------------------------------------------------------------
// Verifies the webhook HMAC (base64 HMAC-SHA256 of the RAW body with the app
// secret — distinct from the OAuth callback HMAC which is hex over the query
// string), then routes by topic into the SAME upsert logic the poll sync uses.
// Idempotent (keyed on externalId), so at-least-once delivery / redelivery is
// safe. Never logs secrets, tokens, or raw payloads.
// ============================================================================

import crypto from "crypto";
import { prisma } from "../../config/database";
import { getApiSecret } from "./config";
import { upsertShopCustomer, upsertOrderDeal, shopifyAddressFields } from "../ecommerce.service";
import {
  upsertShopifyProduct,
  shopifyProductUpsertInput,
  shopifyOrderCustomerInput,
  deleteShopifyProduct,
} from "./sync";
import { getConnectionByShopDomain } from "./connections.service";
import { recordIntegrationEvent } from "../integration-events.service";

// Data topics we subscribe to + process into the CRM.
export const DATA_TOPICS = [
  "products/create",
  "products/update",
  "products/delete",
  "orders/create",
  "orders/updated",
  "orders/cancelled",
  "customers/create",
  "customers/update",
  "customers/delete",
] as const;

// Mandatory GDPR/CCPA compliance topics — verify + log only.
export const COMPLIANCE_TOPICS = new Set([
  "customers/data_request",
  "customers/redact",
  "shop/redact",
]);

/**
 * Verify the webhook signature: base64( HMAC-SHA256( rawBody, appSecret ) )
 * must equal the X-Shopify-Hmac-Sha256 header. Constant-time compare.
 */
export function verifyWebhookHmac(rawBody: Buffer, hmacHeader: string | undefined): boolean {
  const secret = getApiSecret();
  if (!secret || !hmacHeader) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(hmacHeader, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ──────────────────────────────────────────────────────────────────────
// Topic handlers (reuse the shared upsert logic).
// ──────────────────────────────────────────────────────────────────────
async function handleOrder(companyId: string, o: any): Promise<void> {
  if (!o.customer?.id) return; // guest checkout — no CRM contact to link
  const customerId = await upsertShopCustomer(
    companyId,
    "shopify",
    String(o.customer.id),
    shopifyOrderCustomerInput(o)
  );
  const value = parseFloat(o.total_price || "0") || 0;
  const isPaid = o.financial_status === "paid";
  const closedAt = isPaid && o.closed_at ? new Date(o.closed_at) : null;
  await upsertOrderDeal(companyId, customerId, "shopify", {
    externalId: String(o.id),
    value,
    currency: o.currency || null,
    isPaid,
    closedAt,
  });
}

// orders/cancelled → mark the linked Deal lost (Q1 default). We never delete
// CRM history on a Shopify-side change.
async function handleOrderCancelled(companyId: string, o: any): Promise<void> {
  const title = `shopify order #${o.id}`;
  await prisma.deal.updateMany({
    where: { companyId, title },
    data: { stage: "lost", probability: 0 },
  });
}

async function handleCustomer(companyId: string, c: any): Promise<void> {
  const addr = c.default_address || c.addresses?.[0] || null;
  await upsertShopCustomer(companyId, "shopify", String(c.id), {
    fullName:
      [c.first_name, c.last_name].filter(Boolean).join(" ").trim() ||
      c.email ||
      `Customer ${c.id}`,
    email: c.email,
    phone: c.phone,
    ...shopifyAddressFields(addr),
    country: addr?.country,
    city: addr?.city,
    lifetimeValue: parseFloat(c.total_spent) || 0,
  });
}

/**
 * Process a verified webhook. Looks up the connection by shop, routes by topic,
 * and records a webhook_received / webhook_failed event. Never throws — the
 * controller has already acked Shopify with a 200.
 */
export async function processWebhook(
  topic: string,
  shopDomain: string,
  payload: any,
  webhookId: string | undefined
): Promise<void> {
  // Compliance topics: no data store, log-only (HMAC already verified).
  if (COMPLIANCE_TOPICS.has(topic)) {
    await recordIntegrationEvent({
      companyId: null,
      eventType: "webhook_received",
      requestContext: { shop: shopDomain, topic, webhookId, compliance: true },
    });
    return;
  }

  const conn = await getConnectionByShopDomain(shopDomain);
  if (!conn) {
    await recordIntegrationEvent({
      companyId: null,
      eventType: "webhook_failed",
      errorCode: "NO_CONNECTION",
      errorMessage: `No Shopify connection for shop ${shopDomain}`,
      requestContext: { shop: shopDomain, topic, webhookId },
    });
    return;
  }
  const companyId = conn.companyId;

  try {
    switch (topic) {
      case "products/create":
      case "products/update":
        await upsertShopifyProduct(
          shopifyProductUpsertInput(payload, companyId, conn.id),
          conn.currency
        );
        break;
      case "products/delete":
        await deleteShopifyProduct(companyId, String(payload.id));
        break;
      case "orders/create":
      case "orders/updated":
        await handleOrder(companyId, payload);
        break;
      case "orders/cancelled":
        await handleOrderCancelled(companyId, payload);
        break;
      case "customers/create":
      case "customers/update":
        await handleCustomer(companyId, payload);
        break;
      case "customers/delete":
        // Q1 default: keep the CRM contact — never destroy CRM history on a
        // Shopify-side delete. Recorded below as received, no mutation.
        break;
      default:
        break; // unknown/unsubscribed topic — acknowledged, ignored
    }
    await recordIntegrationEvent({
      companyId,
      eventType: "webhook_received",
      requestContext: { shop: shopDomain, topic, webhookId, connectionId: conn.id },
    });
  } catch (err) {
    await recordIntegrationEvent({
      companyId,
      eventType: "webhook_failed",
      errorCode: (err as { code?: string }).code ?? "WEBHOOK_HANDLER_ERROR",
      errorMessage: (err as Error).message,
      requestContext: { shop: shopDomain, topic, webhookId, connectionId: conn.id },
    });
  }
}
