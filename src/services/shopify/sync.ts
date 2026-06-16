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

import { prisma } from "../../config/database";
import { fetchWithLimit } from "../../utils/rateLimiter";
import { upsertShopCustomer, upsertOrderDeal, shopifyAddressFields } from "../ecommerce.service";
import { getApiVersion } from "./config";
import {
  getValidAccessToken,
  recordSyncResult,
  type ShopifyConnectionRow,
} from "./connections.service";
import { recordIntegrationEvent } from "../integration-events.service";
import { bridgeUpsertProduct, bridgeArchiveProduct } from "./product-bridge";

interface SyncResult {
  customers: number;
  orders: number;
  products: number;
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
      const addr = sc.default_address || sc.addresses?.[0] || null;
      await upsertShopCustomer(companyId, "shopify", String(sc.id), {
        fullName,
        email: sc.email,
        phone: sc.phone,
        ...shopifyAddressFields(addr),
        country: addr?.country,
        city: addr?.city,
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

// Build the upsertShopCustomer input for a Shopify ORDER's customer, enriched
// with the order's shipping/billing address (the fulfillment destination) — the
// data the bare order.customer object drops. Prefers shipping_address, then
// billing_address, then the customer's default_address. Shared by the order
// poll (syncOrders) and the orders/* webhook (handleOrder) so both behave
// identically.
export function shopifyOrderCustomerInput(order: any) {
  const c = order.customer || {};
  const addr =
    order.shipping_address || order.billing_address || c.default_address || null;
  const fullName =
    [c.first_name, c.last_name].filter(Boolean).join(" ").trim() ||
    (addr ? [addr.first_name, addr.last_name].filter(Boolean).join(" ").trim() : "") ||
    c.email ||
    `Customer ${c.id}`;
  return {
    fullName,
    email: c.email ?? null,
    phone: c.phone || addr?.phone || null,
    ...shopifyAddressFields(addr),
    country: addr?.country ?? null,
    city: addr?.city ?? null,
  };
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
      const customerId = await upsertShopCustomer(
        companyId,
        "shopify",
        String(order.customer.id),
        shopifyOrderCustomerInput(order)
      );
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

// ─── PRODUCTS ───────────────────────────────────────────────────────────
export interface ShopifyProductInput {
  companyId: string;
  connectionId: string;
  externalId: string;
  title: string | null;
  handle: string | null;
  vendor: string | null;
  productType: string | null;
  status: string | null;
  variantsCount: number;
  sku: string | null;
  price: number | null;
  inventoryQuantity: number | null;
  imageUrl: string | null;
}

// Map a Shopify product object (REST list item OR products/* webhook payload —
// same shape) to our upsert input. Shared by the poll sync and the webhook.
export function shopifyProductUpsertInput(
  pr: any,
  companyId: string,
  connectionId: string
): ShopifyProductInput {
  const variants: any[] = Array.isArray(pr.variants) ? pr.variants : [];
  const first = variants[0] || {};
  const inventory = variants.reduce(
    (sum, v) => sum + (parseInt(v?.inventory_quantity, 10) || 0),
    0
  );
  const imageUrl = pr.image?.src || pr.images?.[0]?.src || null;
  return {
    companyId,
    connectionId,
    externalId: String(pr.id),
    title: pr.title ?? null,
    handle: pr.handle ?? null,
    vendor: pr.vendor || null,
    productType: pr.product_type || null,
    status: pr.status ?? null,
    variantsCount: variants.length,
    sku: first.sku || null,
    price: first.price != null ? parseFloat(first.price) || 0 : null,
    inventoryQuantity: variants.length ? inventory : null,
    imageUrl,
  };
}

/** Delete a product row (products/delete webhook). */
export async function deleteShopifyProduct(
  companyId: string,
  externalId: string
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `DELETE FROM shopify_products WHERE "companyId" = $1 AND "externalId" = $2`,
    companyId,
    externalId
  );
  // Additive bridge: archive (never delete) the unified-catalog row so deal
  // line-item history survives. Best-effort — never breaks the primary delete.
  await bridgeArchiveProduct(companyId, externalId).catch((e) =>
    console.error("[shopify] catalog bridge archive failed:", (e as Error).message)
  );
}

// Upsert one product (raw SQL — matches the connections.service pattern and
// avoids depending on the generated client). Keyed on (companyId, externalId).
export async function upsertShopifyProduct(
  p: ShopifyProductInput,
  currency?: string | null
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO shopify_products
       ("id","companyId","connectionId","externalId","title","handle","vendor","productType",
        "status","variantsCount","sku","price","inventoryQuantity","imageUrl","createdAt","updatedAt")
     VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW())
     ON CONFLICT ("companyId","externalId") DO UPDATE SET
       "connectionId"=EXCLUDED."connectionId","title"=EXCLUDED."title","handle"=EXCLUDED."handle",
       "vendor"=EXCLUDED."vendor","productType"=EXCLUDED."productType","status"=EXCLUDED."status",
       "variantsCount"=EXCLUDED."variantsCount","sku"=EXCLUDED."sku","price"=EXCLUDED."price",
       "inventoryQuantity"=EXCLUDED."inventoryQuantity","imageUrl"=EXCLUDED."imageUrl","updatedAt"=NOW()`,
    p.companyId, p.connectionId, p.externalId, p.title, p.handle, p.vendor, p.productType,
    p.status, p.variantsCount, p.sku, p.price, p.inventoryQuantity, p.imageUrl
  );
  // Additive bridge into the unified catalog (products.source='shopify').
  // Best-effort — a bridge failure must NOT break the shopify_products sync
  // that existing consumers depend on.
  await bridgeUpsertProduct(p, currency).catch((e) =>
    console.error("[shopify] catalog bridge upsert failed:", (e as Error).message)
  );
}

async function syncProducts(
  domain: string,
  token: string,
  companyId: string,
  connectionId: string,
  version: string,
  shopCurrency: string | null
): Promise<number> {
  let imported = 0;
  let pageInfo: string | null = null;
  let page = 0;

  while (page < MAX_PAGES) {
    const url = pageInfo
      ? `https://${domain}/admin/api/${version}/products.json?limit=250&page_info=${encodeURIComponent(pageInfo)}`
      : `https://${domain}/admin/api/${version}/products.json?limit=250`;
    const resp = await fetchWithLimit("shopify", domain, url, {
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    });
    if (!resp.ok) break;
    const data = (await resp.json()) as { products?: any[] };
    if (!data.products || data.products.length === 0) break;

    for (const pr of data.products) {
      await upsertShopifyProduct(
        shopifyProductUpsertInput(pr, companyId, connectionId),
        shopCurrency
      );
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

    // Per-store currency: fetch the shop's currency once and persist it on the
    // connection, so bridged catalog products are stamped with the real store
    // currency instead of the products table's TRY default. Best-effort — a
    // failure here never blocks the sync (falls back to the stored value).
    let shopCurrency: string | null = conn.currency ?? null;
    try {
      const shopResp = await fetchWithLimit(
        "shopify",
        conn.shopDomain,
        `https://${conn.shopDomain}/admin/api/${version}/shop.json`,
        { headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" } }
      );
      if (shopResp.ok) {
        const shopData = (await shopResp.json()) as { shop?: { currency?: string } };
        const cur = shopData.shop?.currency?.trim();
        if (cur) {
          shopCurrency = cur.toUpperCase();
          await prisma.$executeRawUnsafe(
            `UPDATE shopify_connections SET currency = $1, "updatedAt" = NOW() WHERE id = $2`,
            shopCurrency,
            conn.id
          );
        }
      }
    } catch (e) {
      console.warn(
        `[shopify] shop currency fetch failed for ${conn.shopDomain} (non-blocking):`,
        (e as Error).message
      );
    }

    const customers = await syncCustomers(conn.shopDomain, token, conn.companyId, version);
    const orders = await syncOrders(conn.shopDomain, token, conn.companyId, version);
    // Products are best-effort: a product-sync failure (e.g. missing scope or
    // table) must never fail the core customer/order sync.
    let products = 0;
    try {
      products = await syncProducts(conn.shopDomain, token, conn.companyId, conn.id, version, shopCurrency);
    } catch (e) {
      console.warn(
        `[shopify] product sync failed for ${conn.shopDomain} (non-blocking):`,
        (e as Error).message
      );
    }
    const durationMs = Date.now() - started;

    await recordSyncResult(conn.id, durationMs, null);
    await recordIntegrationEvent({
      companyId: conn.companyId,
      eventType: "sync_success",
      durationMs,
      requestContext: { shop: conn.shopDomain, connectionId: conn.id, customers, orders, products },
    });
    return { customers, orders, products };
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
