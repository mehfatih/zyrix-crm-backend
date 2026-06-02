// ============================================================================
// SHOPIFY SYNC (OAuth connections)
// ----------------------------------------------------------------------------
// Pulls customers + orders for a shopify_connections record into the CRM
// (Customer + Deal), reusing the shared upsert helpers. Reads the access
// token via getValidAccessToken (decrypt + refresh-if-needed, in memory) so
// no plaintext token is ever persisted. Records sync lifecycle events +
// duration into integration_events and the connection row.
//
// This is intentionally self-contained (not routed through the legacy
// ecommerce.service plaintext-token engine) so the new OAuth path keeps
// tokens encrypted at rest end-to-end.
// ============================================================================

import { fetchWithLimit } from "../../utils/rateLimiter";
import { upsertShopCustomer, upsertOrderDeal } from "../ecommerce.service";
import { getApiVersion } from "./config";
import {
  getValidAccessToken,
  recordSyncResult,
  type ShopifyConnectionRow,
} from "./connections.service";
import { recordIntegrationEvent } from "../integration-events.service";

interface SyncResult {
  customers: number;
  orders: number;
}

const MAX_PAGES = 20;

async function syncCustomers(
  domain: string,
  token: string,
  companyId: string,
  version: string
): Promise<number> {
  let imported = 0;
  let pageInfo: string | null = null;
  let page = 0;

  while (page < MAX_PAGES) {
    const url = pageInfo
      ? `https://${domain}/admin/api/${version}/customers.json?limit=250&page_info=${encodeURIComponent(pageInfo)}`
      : `https://${domain}/admin/api/${version}/customers.json?limit=250`;
    const resp = await fetchWithLimit("shopify", domain, url, {
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    });
    if (!resp.ok) break;
    const data = (await resp.json()) as { customers?: any[] };
    if (!data.customers || data.customers.length === 0) break;

    for (const sc of data.customers) {
      const fullName =
        [sc.first_name, sc.last_name].filter(Boolean).join(" ").trim() ||
        sc.email ||
        `Customer ${sc.id}`;
      const address = sc.addresses?.[0];
      await upsertShopCustomer(companyId, "shopify", String(sc.id), {
        fullName,
        email: sc.email,
        phone: sc.phone,
        address: address
          ? [address.address1, address.city, address.country].filter(Boolean).join(", ")
          : null,
        country: address?.country,
        city: address?.city,
        notes: sc.note,
        lifetimeValue: parseFloat(sc.total_spent) || 0,
      });
      imported++;
    }

    const linkHeader = resp.headers.get("link") || "";
    const nextMatch = linkHeader.match(/<[^>]*page_info=([^&>]+)[^>]*>;\s*rel="next"/);
    if (nextMatch) {
      pageInfo = decodeURIComponent(nextMatch[1]);
      page++;
    } else break;
  }
  return imported;
}

async function syncOrders(
  domain: string,
  token: string,
  companyId: string,
  version: string
): Promise<number> {
  let synced = 0;
  let pageInfo: string | null = null;
  let page = 0;
  const since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();

  while (page < MAX_PAGES) {
    const url = pageInfo
      ? `https://${domain}/admin/api/${version}/orders.json?limit=250&status=any&page_info=${encodeURIComponent(pageInfo)}`
      : `https://${domain}/admin/api/${version}/orders.json?limit=250&status=any&created_at_min=${encodeURIComponent(since)}`;
    const resp = await fetchWithLimit("shopify", domain, url, {
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    });
    if (!resp.ok) break;
    const data = (await resp.json()) as { orders?: any[] };
    if (!data.orders || data.orders.length === 0) break;

    for (const order of data.orders) {
      if (!order.customer?.id) continue; // guest checkout — skip
      const customerId = await upsertShopCustomer(companyId, "shopify", String(order.customer.id), {
        fullName:
          [order.customer.first_name, order.customer.last_name].filter(Boolean).join(" ").trim() ||
          order.customer.email ||
          `Customer ${order.customer.id}`,
        email: order.customer.email,
        phone: order.customer.phone,
      });
      const value = parseFloat(order.total_price || "0") || 0;
      const isPaid = order.financial_status === "paid";
      const closedAt = isPaid && order.closed_at ? new Date(order.closed_at) : null;
      await upsertOrderDeal(companyId, customerId, "shopify", {
        externalId: String(order.id),
        value,
        currency: order.currency || null,
        isPaid,
        closedAt,
      });
      synced++;
    }

    const linkHeader = resp.headers.get("link") || "";
    const nextMatch = linkHeader.match(/<[^>]*page_info=([^&>]+)[^>]*>;\s*rel="next"/);
    if (nextMatch) {
      pageInfo = decodeURIComponent(nextMatch[1]);
      page++;
    } else break;
  }
  return synced;
}

/**
 * Run a full sync for one connection. Records sync_start/sync_success/
 * sync_failure events with duration. Never throws — returns null on failure
 * (the connection row + events capture the error) so callers (cron, trigger)
 * stay simple.
 */
export async function runShopifySync(
  conn: ShopifyConnectionRow
): Promise<SyncResult | null> {
  const started = Date.now();
  await recordIntegrationEvent({
    companyId: conn.companyId,
    eventType: "sync_start",
    requestContext: { shop: conn.shopDomain, connectionId: conn.id },
  });

  try {
    const token = await getValidAccessToken(conn);
    const version = getApiVersion();
    const customers = await syncCustomers(conn.shopDomain, token, conn.companyId, version);
    const orders = await syncOrders(conn.shopDomain, token, conn.companyId, version);
    const durationMs = Date.now() - started;

    await recordSyncResult(conn.id, durationMs, null);
    await recordIntegrationEvent({
      companyId: conn.companyId,
      eventType: "sync_success",
      durationMs,
      requestContext: { shop: conn.shopDomain, connectionId: conn.id, customers, orders },
    });
    return { customers, orders };
  } catch (err) {
    const durationMs = Date.now() - started;
    const e = err as { code?: string; message?: string };
    await recordSyncResult(conn.id, durationMs, e.message ?? "sync failed");
    await recordIntegrationEvent({
      companyId: conn.companyId,
      eventType: "sync_failure",
      errorCode: e.code ?? "INTERNAL_ERROR",
      errorMessage: e.message ?? "sync failed",
      durationMs,
      requestContext: { shop: conn.shopDomain, connectionId: conn.id },
    });
    return null;
  }
}

/**
 * Fire-and-forget initial sync kicked off right after a successful connect.
 * Detached from the HTTP response so the merchant's redirect isn't blocked.
 */
export function triggerInitialSync(conn: ShopifyConnectionRow): void {
  void runShopifySync(conn).catch((e) => {
    console.error("[shopify] initial sync error (non-fatal):", e?.message || e);
  });
}
