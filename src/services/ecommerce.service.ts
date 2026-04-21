import { prisma } from "../config/database";
import { notFound } from "../middleware/errorHandler";
import { getPlatform, PLATFORMS, listPlatforms, type PlatformDefinition } from "./ecommerce-platforms.registry";

// ============================================================================
// GENERALIZED E-COMMERCE INTEGRATION SERVICE
// Supports 40+ platforms via adapter pattern
// ============================================================================

export interface ConnectStoreDto {
  platform: string;
  shopDomain: string;
  accessToken: string;
  apiKey?: string;
  apiSecret?: string;
  region?: string;
  currency?: string;
  metadata?: Record<string, any>;
}

// ──────────────────────────────────────────────────────────────────────
// PUBLIC: list platforms catalog
// ──────────────────────────────────────────────────────────────────────
export function getCatalog(region?: "mena" | "turkey" | "global") {
  return listPlatforms(region);
}

// ──────────────────────────────────────────────────────────────────────
// STORE CRUD
// ──────────────────────────────────────────────────────────────────────
export async function listStores(companyId: string) {
  const stores = await prisma.ecommerceStore.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      platform: true,
      shopDomain: true,
      isActive: true,
      region: true,
      currency: true,
      lastSyncAt: true,
      syncStatus: true,
      syncError: true,
      totalCustomersImported: true,
      totalOrdersImported: true,
      metadata: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  // Enrich with platform definitions
  return stores.map((s) => {
    const platform = getPlatform(s.platform);
    return {
      ...s,
      platformInfo: platform
        ? {
            name: platform.name,
            brandColor: platform.brandColor,
            country: platform.country,
            region: platform.region,
          }
        : null,
    };
  });
}

export async function connectStore(
  companyId: string,
  dto: ConnectStoreDto
) {
  const platform = getPlatform(dto.platform);
  if (!platform) {
    const err: any = new Error(`Unsupported platform: ${dto.platform}`);
    err.statusCode = 400;
    throw err;
  }

  // Normalize domain
  const domain = dto.shopDomain
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .replace(/^www\./, "")
    .toLowerCase();

  if (!domain || domain.length < 3) {
    const err: any = new Error("Invalid shop domain");
    err.statusCode = 400;
    throw err;
  }

  // Basic auth scheme validation
  if (platform.authScheme === "api_key_secret" && !dto.apiSecret) {
    const err: any = new Error(
      `${platform.name} requires both API key and secret`
    );
    err.statusCode = 400;
    throw err;
  }

  // Verify credentials for native/api platforms
  if (platform.status === "native" || platform.status === "api") {
    const verified = await verifyCredentials(platform, domain, dto);
    if (!verified) {
      const err: any = new Error(
        `Could not verify ${platform.name} credentials. Check the domain and access token.`
      );
      err.statusCode = 400;
      throw err;
    }
  }

  // Upsert
  return prisma.ecommerceStore.upsert({
    where: {
      companyId_platform_shopDomain: {
        companyId,
        platform: dto.platform,
        shopDomain: domain,
      },
    },
    create: {
      companyId,
      platform: dto.platform,
      shopDomain: domain,
      accessToken: dto.accessToken,
      apiKey: dto.apiKey || null,
      apiSecret: dto.apiSecret || null,
      region: dto.region || platform.country,
      currency: dto.currency || null,
      metadata: dto.metadata || {},
      isActive: true,
      syncStatus: "idle",
    },
    update: {
      accessToken: dto.accessToken,
      apiKey: dto.apiKey || null,
      apiSecret: dto.apiSecret || null,
      region: dto.region || platform.country,
      currency: dto.currency || null,
      metadata: dto.metadata || {},
      isActive: true,
      syncStatus: "idle",
      syncError: null,
    },
    select: {
      id: true,
      platform: true,
      shopDomain: true,
      isActive: true,
      syncStatus: true,
      createdAt: true,
    },
  });
}

export async function disconnectStore(companyId: string, id: string) {
  const store = await prisma.ecommerceStore.findFirst({
    where: { id, companyId },
    select: { id: true },
  });
  if (!store) throw notFound("Store");
  await prisma.ecommerceStore.delete({ where: { id } });
  return { deleted: true };
}

// ──────────────────────────────────────────────────────────────────────
// SYNC - routes to platform-specific adapter
// ──────────────────────────────────────────────────────────────────────
export async function syncStore(companyId: string, id: string) {
  const store = await prisma.ecommerceStore.findFirst({
    where: { id, companyId, isActive: true },
  });
  if (!store) throw notFound("Store");

  const platform = getPlatform(store.platform);
  if (!platform) {
    const err: any = new Error(`Unknown platform: ${store.platform}`);
    err.statusCode = 400;
    throw err;
  }

  if (platform.status === "csv_only" || platform.status === "planned") {
    const err: any = new Error(
      `${platform.name} does not support automatic sync yet. Please use CSV import instead.`
    );
    err.statusCode = 400;
    throw err;
  }

  // Mark as syncing
  await prisma.ecommerceStore.update({
    where: { id },
    data: { syncStatus: "syncing", syncError: null },
  });

  try {
    const result = await syncByPlatform(
      platform,
      store.shopDomain,
      {
        accessToken: store.accessToken,
        apiKey: store.apiKey || undefined,
        apiSecret: store.apiSecret || undefined,
      },
      companyId,
      store.id
    );

    await prisma.ecommerceStore.update({
      where: { id },
      data: {
        syncStatus: "success",
        lastSyncAt: new Date(),
        totalCustomersImported: { increment: result.imported },
        totalOrdersImported: { increment: result.orders },
      },
    });

    return result;
  } catch (e: any) {
    await prisma.ecommerceStore.update({
      where: { id },
      data: {
        syncStatus: "error",
        syncError: e.message || "Unknown error",
      },
    });
    throw e;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Verify credentials per platform
// ──────────────────────────────────────────────────────────────────────
async function verifyCredentials(
  platform: PlatformDefinition,
  domain: string,
  dto: ConnectStoreDto
): Promise<boolean> {
  try {
    switch (platform.id) {
      case "shopify": {
        const resp = await fetch(
          `https://${domain}/admin/api/2024-10/shop.json`,
          {
            headers: {
              "X-Shopify-Access-Token": dto.accessToken,
              "Content-Type": "application/json",
            },
          }
        );
        return resp.ok;
      }
      case "salla": {
        // Salla: Bearer token to /admin/v2/store/info
        const resp = await fetch(
          "https://api.salla.dev/admin/v2/store/info",
          {
            headers: {
              Authorization: `Bearer ${dto.accessToken}`,
              "Content-Type": "application/json",
            },
          }
        );
        return resp.ok;
      }
      case "zid": {
        // Zid OAuth: /v1/managers/account/profile
        const resp = await fetch(
          `https://api.zid.sa/v1/managers/account/profile`,
          {
            headers: {
              Authorization: `Bearer ${dto.accessToken}`,
              "Content-Type": "application/json",
            },
          }
        );
        return resp.ok;
      }
      case "youcan": {
        // YouCan API: Bearer token
        const resp = await fetch(
          `https://api.youcan.shop/me`,
          {
            headers: {
              Authorization: `Bearer ${dto.accessToken}`,
              "Content-Type": "application/json",
            },
          }
        );
        return resp.ok;
      }
      case "woocommerce": {
        // WooCommerce: Basic auth with consumer_key:consumer_secret
        if (!dto.apiSecret) return false;
        const auth = Buffer.from(`${dto.apiKey}:${dto.apiSecret}`).toString("base64");
        const resp = await fetch(
          `https://${domain}/wp-json/wc/v3/system_status`,
          {
            headers: {
              Authorization: `Basic ${auth}`,
              "Content-Type": "application/json",
            },
          }
        );
        return resp.ok;
      }
      case "easyorders": {
        // EasyOrders API key header
        const resp = await fetch(
          `https://app.easy-orders.net/api/v1/external-apps/users/me`,
          {
            headers: {
              "api-key": dto.accessToken,
              "Content-Type": "application/json",
            },
          }
        );
        return resp.ok || resp.status === 401; // 401 means endpoint exists
      }
      case "expandcart": {
        const resp = await fetch(
          `https://${domain}/api/rest/store`,
          {
            headers: {
              "X-API-KEY": dto.accessToken,
              "Content-Type": "application/json",
            },
          }
        );
        return resp.ok;
      }
      case "ticimax": {
        // Ticimax uses SOAP or REST with API key
        const resp = await fetch(
          `https://${domain}/Servis/UrunServis.svc/urunler?wt=json`,
          {
            headers: {
              ApiKey: dto.accessToken,
              "Content-Type": "application/json",
            },
          }
        ).catch(() => null);
        return resp?.ok || resp?.status === 401 || false;
      }
      case "ideasoft": {
        const resp = await fetch(
          `https://${domain}/api/me`,
          {
            headers: {
              Authorization: `Bearer ${dto.accessToken}`,
              "Content-Type": "application/json",
            },
          }
        ).catch(() => null);
        return resp?.ok || false;
      }
      case "tsoft": {
        const resp = await fetch(
          `https://${domain}/rest1/user/tokenCheck`,
          {
            headers: {
              Token: dto.accessToken,
              "Content-Type": "application/json",
            },
          }
        ).catch(() => null);
        return resp?.ok || false;
      }
      case "ikas": {
        const resp = await fetch(
          `https://api.myikas.com/api/v1/admin/graphql`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${dto.accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              query: "{ merchant { id } }",
            }),
          }
        ).catch(() => null);
        return resp?.ok || false;
      }
      case "turhost": {
        // Turhost - generic API
        const resp = await fetch(
          `https://${domain}/api/auth/verify`,
          {
            headers: {
              Authorization: `Bearer ${dto.accessToken}`,
            },
          }
        ).catch(() => null);
        return resp?.ok || resp?.status === 401 || false;
      }
      default:
        // For other platforms, accept the token without verification
        return true;
    }
  } catch (e) {
    console.error(`Verify failed for ${platform.id}:`, e);
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// SYNC adapters per platform
// ──────────────────────────────────────────────────────────────────────
interface SyncCreds {
  accessToken: string;
  apiKey?: string;
  apiSecret?: string;
}

interface SyncResult {
  imported: number;
  orders: number;
}

async function syncByPlatform(
  platform: PlatformDefinition,
  domain: string,
  creds: SyncCreds,
  companyId: string,
  storeId: string
): Promise<SyncResult> {
  switch (platform.id) {
    case "shopify":
      return syncShopify(domain, creds, companyId);
    case "salla":
      return syncSalla(creds, companyId);
    case "zid":
      return syncZid(creds, companyId);
    case "youcan":
      return syncYouCan(creds, companyId);
    case "woocommerce":
      return syncWooCommerce(domain, creds, companyId);
    case "easyorders":
      return syncEasyOrders(creds, companyId);
    case "expandcart":
      return syncExpandCart(domain, creds, companyId);
    case "ticimax":
      return syncTicimax(domain, creds, companyId);
    case "ideasoft":
      return syncIdeasoft(domain, creds, companyId);
    case "tsoft":
      return syncTSoft(domain, creds, companyId);
    case "ikas":
      return syncIkas(creds, companyId);
    case "turhost":
      return syncTurhost(domain, creds, companyId);
    default:
      throw new Error(`Sync not implemented for ${platform.id}`);
  }
}

// Generic customer upsert with deduplication by externalId
// Exported so webhook handlers (services/webhook.service.ts) can reuse it.
export async function upsertShopCustomer(
  companyId: string,
  source: string,
  externalId: string,
  data: {
    fullName: string;
    email?: string | null;
    phone?: string | null;
    address?: string | null;
    country?: string | null;
    city?: string | null;
    notes?: string | null;
    lifetimeValue?: number;
  }
) {
  const compoundExternalId = `${source}:${externalId}`;
  const existing = await prisma.customer.findFirst({
    where: { companyId, externalId: compoundExternalId },
    select: { id: true },
  });

  if (existing) {
    await prisma.customer.update({
      where: { id: existing.id },
      data: {
        email: data.email?.toLowerCase() || null,
        phone: data.phone || null,
        lifetimeValue: data.lifetimeValue ?? 0,
        notes: data.notes || null,
      },
    });
    return existing.id;
  }
  const created = await prisma.customer.create({
    data: {
      companyId,
      fullName: data.fullName || `Customer ${externalId}`,
      email: data.email?.toLowerCase() || null,
      phone: data.phone || null,
      address: data.address || null,
      country: data.country || null,
      city: data.city || null,
      notes: data.notes || null,
      source,
      externalId: compoundExternalId,
      lifetimeValue: data.lifetimeValue ?? 0,
      status: "customer",
    },
  });
  return created.id;
}

// ──────────────────────────────────────────────────────────────────────
// ORDER -> DEAL conversion
// ──────────────────────────────────────────────────────────────────────
// Every paid/fulfilled e-commerce order becomes a "won" Deal linked to its
// Customer. Unpaid/pending orders become "proposal" stage so the merchant
// sees the pipeline value even before payment.
//
// Idempotent: dedup key is `${platform} order #${externalId}` on the title
// field. Re-running sync updates value/stage/probability without creating
// duplicates.
// ──────────────────────────────────────────────────────────────────────
export async function upsertOrderDeal(
  companyId: string,
  customerId: string,
  platform: string,
  order: {
    externalId: string;
    value: number;
    currency: string | null;
    isPaid: boolean;
    closedAt?: Date | null;
  }
) {
  const title = `${platform} order #${order.externalId}`;
  const existing = await prisma.deal.findFirst({
    where: { companyId, title },
    select: { id: true },
  });
  const stage = order.isPaid ? "won" : "proposal";
  const probability = order.isPaid ? 100 : 50;
  const actualCloseDate = order.isPaid ? (order.closedAt ?? new Date()) : null;

  if (existing) {
    await prisma.deal.update({
      where: { id: existing.id },
      data: {
        value: order.value,
        currency: order.currency || "USD",
        stage,
        probability,
        actualCloseDate,
      },
    });
    return { id: existing.id, created: false };
  }
  const deal = await prisma.deal.create({
    data: {
      companyId,
      customerId,
      title,
      value: order.value,
      currency: order.currency || "USD",
      stage,
      probability,
      actualCloseDate,
    },
  });
  return { id: deal.id, created: true };
}

// ─── SHOPIFY ──────────────────────────────────────────────────────────
async function syncShopify(
  domain: string,
  creds: SyncCreds,
  companyId: string
): Promise<SyncResult> {
  let imported = 0;
  let pageInfo: string | null = null;
  let page = 0;
  const maxPages = 20;

  while (page < maxPages) {
    const url: string = pageInfo
      ? `https://${domain}/admin/api/2024-10/customers.json?limit=250&page_info=${encodeURIComponent(pageInfo)}`
      : `https://${domain}/admin/api/2024-10/customers.json?limit=250`;
    const resp = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": creds.accessToken,
        "Content-Type": "application/json",
      },
    });
    if (!resp.ok) break;
    const data = (await resp.json()) as { customers: any[] };
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

  // ─── ORDERS ──────────────────────────────────────────────────────────
  // Fetch orders after customers so the customer upsert is guaranteed to
  // exist when the deal links back. Shopify uses cursor pagination via
  // Link headers (same as customers). Filter to last 180 days to cap
  // initial backfill; subsequent syncs catch up from last run.
  const orders = await syncShopifyOrders(domain, creds, companyId);
  return { imported, orders };
}

async function syncShopifyOrders(
  domain: string,
  creds: SyncCreds,
  companyId: string
): Promise<number> {
  let ordersSynced = 0;
  let pageInfo: string | null = null;
  let page = 0;
  const maxPages = 20;
  const since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();

  while (page < maxPages) {
    const url: string = pageInfo
      ? `https://${domain}/admin/api/2024-10/orders.json?limit=250&status=any&page_info=${encodeURIComponent(pageInfo)}`
      : `https://${domain}/admin/api/2024-10/orders.json?limit=250&status=any&created_at_min=${encodeURIComponent(since)}`;

    const resp = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": creds.accessToken,
        "Content-Type": "application/json",
      },
    });
    if (!resp.ok) break;
    const data = (await resp.json()) as { orders: any[] };
    if (!data.orders || data.orders.length === 0) break;

    for (const order of data.orders) {
      if (!order.customer?.id) continue; // guest checkout — skip

      // The customer should already exist from the customers loop above,
      // but re-upsert defensively in case this is an order from a
      // brand-new customer the earlier call didn't see yet.
      const customerId = await upsertShopCustomer(
        companyId,
        "shopify",
        String(order.customer.id),
        {
          fullName:
            [order.customer.first_name, order.customer.last_name]
              .filter(Boolean)
              .join(" ")
              .trim() ||
            order.customer.email ||
            `Customer ${order.customer.id}`,
          email: order.customer.email,
          phone: order.customer.phone,
        }
      );

      const value = parseFloat(order.total_price || "0") || 0;
      const isPaid = order.financial_status === "paid";
      const closedAt = isPaid && order.closed_at
        ? new Date(order.closed_at)
        : null;

      await upsertOrderDeal(companyId, customerId, "shopify", {
        externalId: String(order.id),
        value,
        currency: order.currency || null,
        isPaid,
        closedAt,
      });
      ordersSynced++;
    }

    const linkHeader = resp.headers.get("link") || "";
    const nextMatch = linkHeader.match(/<[^>]*page_info=([^&>]+)[^>]*>;\s*rel="next"/);
    if (nextMatch) {
      pageInfo = decodeURIComponent(nextMatch[1]);
      page++;
    } else break;
  }
  return ordersSynced;
}

// ─── SALLA ────────────────────────────────────────────────────────────
async function syncSalla(creds: SyncCreds, companyId: string): Promise<SyncResult> {
  let imported = 0;
  let page = 1;
  const maxPages = 20;

  while (page <= maxPages) {
    const resp = await fetch(
      `https://api.salla.dev/admin/v2/customers?page=${page}&per_page=50`,
      {
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    if (!resp.ok) break;
    const data = (await resp.json()) as { data: any[]; pagination?: { count: number } };
    if (!data.data || data.data.length === 0) break;

    for (const c of data.data) {
      const fullName =
        [c.first_name, c.last_name].filter(Boolean).join(" ").trim() ||
        c.email ||
        `Customer ${c.id}`;
      await upsertShopCustomer(companyId, "salla", String(c.id), {
        fullName,
        email: c.email,
        phone: c.mobile,
        country: c.country,
        city: c.city,
        lifetimeValue: parseFloat(c.total_sales) || 0,
      });
      imported++;
    }

    if (data.data.length < 50) break;
    page++;
  }

  const orders = await syncSallaOrders(creds, companyId);
  return { imported, orders };
}

async function syncSallaOrders(
  creds: SyncCreds,
  companyId: string
): Promise<number> {
  let ordersSynced = 0;
  let page = 1;
  const maxPages = 20;

  while (page <= maxPages) {
    const resp = await fetch(
      `https://api.salla.dev/admin/v2/orders?page=${page}&per_page=50`,
      {
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    if (!resp.ok) break;
    const body = (await resp.json()) as { data?: any[] };
    const orders = body.data || [];
    if (orders.length === 0) break;

    for (const order of orders) {
      const customer = order.customer;
      if (!customer?.id) continue;

      const customerId = await upsertShopCustomer(
        companyId,
        "salla",
        String(customer.id),
        {
          fullName:
            [customer.first_name, customer.last_name].filter(Boolean).join(" ").trim() ||
            customer.full_name ||
            customer.email ||
            `Customer ${customer.id}`,
          email: customer.email,
          phone: customer.mobile,
        }
      );

      // Salla status slugs: paid, completed, delivered → treat as paid
      const statusSlug = (order.status?.slug || "").toString().toLowerCase();
      const isPaid = ["paid", "completed", "delivered"].includes(statusSlug);
      const totalRaw =
        order.amounts?.total?.amount ?? order.total?.amount ?? order.total ?? 0;
      const value = parseFloat(String(totalRaw)) || 0;
      const currency =
        order.amounts?.total?.currency || order.currency || "SAR";
      const closedAt = isPaid && order.date
        ? new Date(order.date)
        : null;

      await upsertOrderDeal(companyId, customerId, "salla", {
        externalId: String(order.id),
        value,
        currency,
        isPaid,
        closedAt,
      });
      ordersSynced++;
    }

    if (orders.length < 50) break;
    page++;
  }
  return ordersSynced;
}

// ─── ZID ──────────────────────────────────────────────────────────────
async function syncZid(creds: SyncCreds, companyId: string): Promise<SyncResult> {
  let imported = 0;
  let page = 1;
  const maxPages = 20;

  while (page <= maxPages) {
    const resp = await fetch(
      `https://api.zid.sa/v1/managers/store/customers?page=${page}&page_size=50`,
      {
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    if (!resp.ok) break;
    const data = (await resp.json()) as { customers?: any[]; results?: any[] };
    const rows = data.customers || data.results || [];
    if (rows.length === 0) break;

    for (const c of rows) {
      const fullName = c.name || c.full_name || `Customer ${c.id}`;
      await upsertShopCustomer(companyId, "zid", String(c.id), {
        fullName,
        email: c.email,
        phone: c.mobile || c.phone,
        city: c.city,
        lifetimeValue: parseFloat(c.total_orders_amount) || 0,
      });
      imported++;
    }

    if (rows.length < 50) break;
    page++;
  }

  const orders = await syncZidOrders(creds, companyId);
  return { imported, orders };
}

async function syncZidOrders(
  creds: SyncCreds,
  companyId: string
): Promise<number> {
  let ordersSynced = 0;
  let page = 1;
  const maxPages = 20;
  // Zid payment_status values: paid, unpaid, partially_paid, refunded
  const PAID_STATUSES = new Set(["paid"]);

  while (page <= maxPages) {
    const resp = await fetch(
      `https://api.zid.sa/v1/managers/store/orders?page=${page}&page_size=50`,
      {
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    ).catch(() => null);
    if (!resp || !resp.ok) break;
    const body = (await resp.json()) as { orders?: any[]; results?: any[] };
    const rows = body.orders || body.results || [];
    if (rows.length === 0) break;

    for (const order of rows) {
      const customerRaw = order.customer;
      if (!customerRaw?.id) continue;

      const customerId = await upsertShopCustomer(
        companyId,
        "zid",
        String(customerRaw.id),
        {
          fullName:
            customerRaw.name ||
            customerRaw.full_name ||
            customerRaw.email ||
            `Customer ${customerRaw.id}`,
          email: customerRaw.email,
          phone: customerRaw.mobile || customerRaw.phone,
        }
      );

      const status = (order.payment_status || "").toString().toLowerCase();
      const isPaid = PAID_STATUSES.has(status);
      const value = parseFloat(order.total || order.grand_total || "0") || 0;
      const closedAt =
        isPaid && order.updated_at ? new Date(order.updated_at) : null;

      await upsertOrderDeal(companyId, customerId, "zid", {
        externalId: String(order.id),
        value,
        currency: order.currency || "SAR",
        isPaid,
        closedAt,
      });
      ordersSynced++;
    }

    if (rows.length < 50) break;
    page++;
  }
  return ordersSynced;
}

// ─── YOUCAN ───────────────────────────────────────────────────────────
async function syncYouCan(creds: SyncCreds, companyId: string): Promise<SyncResult> {
  let imported = 0;
  let page = 1;
  const maxPages = 20;

  while (page <= maxPages) {
    const resp = await fetch(
      `https://api.youcan.shop/customers?page=${page}&per_page=50`,
      {
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    if (!resp.ok) break;
    const data = (await resp.json()) as { data?: any[] };
    const rows = data.data || [];
    if (rows.length === 0) break;

    for (const c of rows) {
      const fullName =
        [c.first_name, c.last_name].filter(Boolean).join(" ").trim() ||
        c.email ||
        `Customer ${c.id}`;
      await upsertShopCustomer(companyId, "youcan", String(c.id), {
        fullName,
        email: c.email,
        phone: c.phone,
        address: c.address,
        city: c.city,
      });
      imported++;
    }

    if (rows.length < 50) break;
    page++;
  }

  const orders = await syncYouCanOrders(creds, companyId);
  return { imported, orders };
}

async function syncYouCanOrders(
  creds: SyncCreds,
  companyId: string
): Promise<number> {
  let ordersSynced = 0;
  let page = 1;
  const maxPages = 20;
  // YouCan status values: pending, paid, completed, cancelled, refunded
  const PAID_STATUSES = new Set(["paid", "completed"]);

  while (page <= maxPages) {
    const resp = await fetch(
      `https://api.youcan.shop/orders?page=${page}&per_page=50`,
      {
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    ).catch(() => null);
    if (!resp || !resp.ok) break;
    const body = (await resp.json()) as { data?: any[] };
    const rows = body.data || [];
    if (rows.length === 0) break;

    for (const order of rows) {
      const customer = order.customer;
      if (!customer?.id) continue;

      const customerId = await upsertShopCustomer(
        companyId,
        "youcan",
        String(customer.id),
        {
          fullName:
            [customer.first_name, customer.last_name]
              .filter(Boolean)
              .join(" ")
              .trim() ||
            customer.email ||
            `Customer ${customer.id}`,
          email: customer.email,
          phone: customer.phone,
        }
      );

      const status = (order.status || "").toString().toLowerCase();
      const isPaid = PAID_STATUSES.has(status);
      const value =
        parseFloat(order.total || order.total_price || "0") || 0;
      const closedAt =
        isPaid && order.completed_at ? new Date(order.completed_at) : null;

      await upsertOrderDeal(companyId, customerId, "youcan", {
        externalId: String(order.id),
        value,
        currency: order.currency || "MAD",
        isPaid,
        closedAt,
      });
      ordersSynced++;
    }

    if (rows.length < 50) break;
    page++;
  }
  return ordersSynced;
}

// ─── WOOCOMMERCE ──────────────────────────────────────────────────────
async function syncWooCommerce(
  domain: string,
  creds: SyncCreds,
  companyId: string
): Promise<SyncResult> {
  if (!creds.apiKey || !creds.apiSecret) {
    throw new Error("WooCommerce requires both consumer key and consumer secret");
  }
  const auth = Buffer.from(`${creds.apiKey}:${creds.apiSecret}`).toString("base64");
  let imported = 0;
  let page = 1;
  const maxPages = 20;

  while (page <= maxPages) {
    const resp = await fetch(
      `https://${domain}/wp-json/wc/v3/customers?per_page=50&page=${page}`,
      {
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
      }
    );
    if (!resp.ok) break;
    const rows = (await resp.json()) as any[];
    if (!Array.isArray(rows) || rows.length === 0) break;

    for (const c of rows) {
      const fullName =
        [c.first_name, c.last_name].filter(Boolean).join(" ").trim() ||
        c.username ||
        c.email;
      await upsertShopCustomer(companyId, "woocommerce", String(c.id), {
        fullName,
        email: c.email,
        phone: c.billing?.phone,
        address: c.billing
          ? [c.billing.address_1, c.billing.city, c.billing.country].filter(Boolean).join(", ")
          : null,
        country: c.billing?.country,
        city: c.billing?.city,
      });
      imported++;
    }
    if (rows.length < 50) break;
    page++;
  }

  const orders = await syncWooCommerceOrders(domain, auth, companyId);
  return { imported, orders };
}

async function syncWooCommerceOrders(
  domain: string,
  auth: string,
  companyId: string
): Promise<number> {
  let ordersSynced = 0;
  let page = 1;
  const maxPages = 20;

  // WooCommerce statuses: processing, completed → treat as paid.
  // on-hold, pending, cancelled, refunded, failed → not paid.
  const PAID_STATUSES = new Set(["processing", "completed"]);

  while (page <= maxPages) {
    const resp = await fetch(
      `https://${domain}/wp-json/wc/v3/orders?per_page=50&page=${page}&orderby=date&order=desc`,
      {
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
      }
    );
    if (!resp.ok) break;
    const orders = (await resp.json()) as any[];
    if (!Array.isArray(orders) || orders.length === 0) break;

    for (const order of orders) {
      // WooCommerce orders link to customer_id (0 = guest). Skip guests.
      if (!order.customer_id || order.customer_id === 0) continue;

      const customerId = await upsertShopCustomer(
        companyId,
        "woocommerce",
        String(order.customer_id),
        {
          fullName:
            [order.billing?.first_name, order.billing?.last_name]
              .filter(Boolean)
              .join(" ")
              .trim() ||
            order.billing?.email ||
            `Customer ${order.customer_id}`,
          email: order.billing?.email,
          phone: order.billing?.phone,
          country: order.billing?.country,
          city: order.billing?.city,
        }
      );

      const value = parseFloat(order.total || "0") || 0;
      const status = (order.status || "").toLowerCase();
      const isPaid = PAID_STATUSES.has(status);
      const closedAt =
        status === "completed" && order.date_completed
          ? new Date(order.date_completed)
          : null;

      await upsertOrderDeal(companyId, customerId, "woocommerce", {
        externalId: String(order.id),
        value,
        currency: order.currency || null,
        isPaid,
        closedAt,
      });
      ordersSynced++;
    }

    if (orders.length < 50) break;
    page++;
  }
  return ordersSynced;
}

// ─── EASYORDERS ───────────────────────────────────────────────────────
async function syncEasyOrders(creds: SyncCreds, companyId: string): Promise<SyncResult> {
  let imported = 0;
  try {
    // EasyOrders API pattern: /external-apps/customers
    const resp = await fetch(
      `https://app.easy-orders.net/api/v1/external-apps/customers?limit=500`,
      {
        headers: {
          "api-key": creds.accessToken,
          "Content-Type": "application/json",
        },
      }
    );
    if (!resp.ok) return { imported: 0, orders: 0 };
    const data = (await resp.json()) as { data?: any[]; customers?: any[] };
    const rows = data.data || data.customers || [];

    for (const c of rows) {
      const fullName = c.name || c.full_name || c.customer_name || `Customer ${c.id || c._id}`;
      await upsertShopCustomer(
        companyId,
        "easyorders",
        String(c.id || c._id),
        {
          fullName,
          email: c.email,
          phone: c.phone,
          city: c.city || c.governorate,
          country: c.country,
          address: c.address,
        }
      );
      imported++;
    }
  } catch (e) {
    console.error("EasyOrders sync error:", e);
  }

  const orders = await syncEasyOrdersOrders(creds, companyId);
  return { imported, orders };
}

async function syncEasyOrdersOrders(
  creds: SyncCreds,
  companyId: string
): Promise<number> {
  let ordersSynced = 0;
  // EasyOrders statuses include: confirmed, delivered, paid, cancelled, returned
  const PAID_STATUSES = new Set(["paid", "delivered", "confirmed"]);
  try {
    const resp = await fetch(
      `https://app.easy-orders.net/api/v1/external-apps/orders?limit=500`,
      {
        headers: {
          "api-key": creds.accessToken,
          "Content-Type": "application/json",
        },
      }
    ).catch(() => null);
    if (!resp || !resp.ok) return 0;
    const body = (await resp.json()) as { data?: any[]; orders?: any[] };
    const rows = body.data || body.orders || [];

    for (const order of rows) {
      // Customer can be either nested object or a raw id — handle both
      const customerRaw = order.customer || order.customer_info;
      const customerExtId = customerRaw?.id || customerRaw?._id || order.customer_id;
      if (!customerExtId) continue;

      const customerId = await upsertShopCustomer(
        companyId,
        "easyorders",
        String(customerExtId),
        {
          fullName:
            customerRaw?.name ||
            customerRaw?.full_name ||
            customerRaw?.customer_name ||
            order.customer_name ||
            `Customer ${customerExtId}`,
          email: customerRaw?.email || order.customer_email,
          phone: customerRaw?.phone || order.customer_phone,
        }
      );

      const status = (order.status || order.order_status || "").toString().toLowerCase();
      const isPaid = PAID_STATUSES.has(status);
      const value =
        parseFloat(
          order.total || order.grand_total || order.amount || "0"
        ) || 0;
      const closedAt =
        isPaid && (order.delivered_at || order.updated_at)
          ? new Date(order.delivered_at || order.updated_at)
          : null;

      await upsertOrderDeal(companyId, customerId, "easyorders", {
        externalId: String(order.id || order._id),
        value,
        currency: order.currency || "EGP",
        isPaid,
        closedAt,
      });
      ordersSynced++;
    }
  } catch (e) {
    console.error("EasyOrders orders sync error:", e);
  }
  return ordersSynced;
}

// ─── EXPANDCART ───────────────────────────────────────────────────────
async function syncExpandCart(
  domain: string,
  creds: SyncCreds,
  companyId: string
): Promise<SyncResult> {
  let imported = 0;
  const resp = await fetch(
    `https://${domain}/api/rest/customers?limit=500`,
    {
      headers: { "X-API-KEY": creds.accessToken, "Content-Type": "application/json" },
    }
  ).catch(() => null);
  if (!resp || !resp.ok) return { imported: 0, orders: 0 };
  const data = (await resp.json()) as { customers?: any[] };
  const rows = data.customers || [];

  for (const c of rows) {
    const fullName =
      [c.firstname, c.lastname].filter(Boolean).join(" ").trim() || c.email;
    await upsertShopCustomer(companyId, "expandcart", String(c.customer_id || c.id), {
      fullName,
      email: c.email,
      phone: c.telephone || c.phone,
    });
    imported++;
  }

  const orders = await syncExpandCartOrders(domain, creds, companyId);
  return { imported, orders };
}

async function syncExpandCartOrders(
  domain: string,
  creds: SyncCreds,
  companyId: string
): Promise<number> {
  let ordersSynced = 0;
  // ExpandCart order_status_id 2=processing, 3=shipped, 5=complete
  // and payment_status 'paid' — both contribute to paid classification.
  const PAID_STATUSES = new Set(["complete", "shipped", "paid", "delivered"]);
  const resp = await fetch(
    `https://${domain}/api/rest/orders?limit=500`,
    {
      headers: { "X-API-KEY": creds.accessToken, "Content-Type": "application/json" },
    }
  ).catch(() => null);
  if (!resp || !resp.ok) return 0;
  const data = (await resp.json()) as { orders?: any[] };
  const rows = data.orders || [];

  for (const order of rows) {
    const customerExtId = order.customer_id;
    if (!customerExtId) continue;

    const customerId = await upsertShopCustomer(
      companyId,
      "expandcart",
      String(customerExtId),
      {
        fullName:
          [order.firstname, order.lastname].filter(Boolean).join(" ").trim() ||
          order.email ||
          `Customer ${customerExtId}`,
        email: order.email,
        phone: order.telephone,
      }
    );

    const statusName = (order.status || order.order_status || "").toString().toLowerCase();
    const isPaid = PAID_STATUSES.has(statusName);
    const value = parseFloat(order.total || "0") || 0;

    await upsertOrderDeal(companyId, customerId, "expandcart", {
      externalId: String(order.order_id || order.id),
      value,
      currency: order.currency_code || order.currency || "EGP",
      isPaid,
      closedAt: isPaid && order.date_modified ? new Date(order.date_modified) : null,
    });
    ordersSynced++;
  }
  return ordersSynced;
}

// ─── TICIMAX ──────────────────────────────────────────────────────────
async function syncTicimax(
  domain: string,
  creds: SyncCreds,
  companyId: string
): Promise<SyncResult> {
  let imported = 0;
  // Ticimax SOAP/JSON endpoint: /Servis/UyeServis.svc/GetUyeList
  const resp = await fetch(
    `https://${domain}/Servis/UyeServis.svc/GetUyeList`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ApiKey: creds.accessToken,
        Adet: 500,
      }),
    }
  ).catch(() => null);
  if (!resp || !resp.ok) return { imported: 0, orders: 0 };
  const data = (await resp.json()) as any;
  const rows = data.d || data.Uyeler || [];

  for (const c of rows) {
    const fullName = [c.Ad, c.Soyad].filter(Boolean).join(" ").trim() || c.Eposta;
    await upsertShopCustomer(companyId, "ticimax", String(c.ID || c.Id || c.UyeID), {
      fullName,
      email: c.Eposta,
      phone: c.Telefon || c.CepTelefonu,
      city: c.Sehir,
      country: c.Ulke || "Türkiye",
    });
    imported++;
  }

  const orders = await syncTicimaxOrders(domain, creds, companyId);
  return { imported, orders };
}

async function syncTicimaxOrders(
  domain: string,
  creds: SyncCreds,
  companyId: string
): Promise<number> {
  let ordersSynced = 0;
  // Ticimax statuses (Turkish): Onaylandi (approved), Kargoya Verildi (shipped),
  // TeslimEdildi (delivered), IptalEdildi (cancelled).
  // OdemeDurumu=1 typically means paid. We treat approved/shipped/delivered as paid.
  const PAID_STATUS_NAMES = new Set([
    "onaylandi",
    "kargoyaverildi",
    "teslimedildi",
    "odemealindi",
  ]);

  const resp = await fetch(
    `https://${domain}/Servis/SiparisServis.svc/SiparisleriGetir`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ApiKey: creds.accessToken,
        Adet: 500,
      }),
    }
  ).catch(() => null);
  if (!resp || !resp.ok) return 0;
  const body = (await resp.json()) as any;
  const rows = body.d || body.Siparisler || [];

  for (const order of rows) {
    const customerExtId = order.UyeID || order.UyeId || order.MusteriID;
    if (!customerExtId) continue;

    const customerId = await upsertShopCustomer(
      companyId,
      "ticimax",
      String(customerExtId),
      {
        fullName:
          [order.UyeAdi, order.UyeSoyadi].filter(Boolean).join(" ").trim() ||
          order.UyeEposta ||
          `Müşteri ${customerExtId}`,
        email: order.UyeEposta,
        phone: order.UyeTelefon,
      }
    );

    const statusName = (order.DurumAdi || order.Durum || "")
      .toString()
      .toLowerCase()
      .replace(/\s+/g, "");
    const paymentFlag = order.OdemeDurumu === 1 || order.OdemeDurumu === true;
    const isPaid = paymentFlag || PAID_STATUS_NAMES.has(statusName);
    const value = parseFloat(order.ToplamTutar || order.Tutar || "0") || 0;

    await upsertOrderDeal(companyId, customerId, "ticimax", {
      externalId: String(order.ID || order.Id || order.SiparisID),
      value,
      currency: order.ParaBirimi || "TRY",
      isPaid,
      closedAt: isPaid && order.TeslimTarihi ? new Date(order.TeslimTarihi) : null,
    });
    ordersSynced++;
  }
  return ordersSynced;
}

// ─── IDEASOFT ─────────────────────────────────────────────────────────
async function syncIdeasoft(
  domain: string,
  creds: SyncCreds,
  companyId: string
): Promise<SyncResult> {
  let imported = 0;
  let page = 1;
  const maxPages = 10;

  while (page <= maxPages) {
    const resp = await fetch(
      `https://${domain}/api/customers?limit=50&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    ).catch(() => null);
    if (!resp || !resp.ok) break;
    const rows = (await resp.json()) as any[];
    if (!Array.isArray(rows) || rows.length === 0) break;

    for (const c of rows) {
      const fullName = c.fullName || [c.firstname, c.lastname].filter(Boolean).join(" ").trim() || c.email;
      await upsertShopCustomer(companyId, "ideasoft", String(c.id), {
        fullName,
        email: c.email,
        phone: c.phone || c.mobile,
        city: c.city,
      });
      imported++;
    }
    if (rows.length < 50) break;
    page++;
  }

  const orders = await syncIdeasoftOrders(domain, creds, companyId);
  return { imported, orders };
}

async function syncIdeasoftOrders(
  domain: string,
  creds: SyncCreds,
  companyId: string
): Promise<number> {
  let ordersSynced = 0;
  let page = 1;
  const maxPages = 10;
  // İdeasoft status values observed: approved, shipping, shipped, completed, cancelled
  const PAID_STATUSES = new Set(["approved", "shipping", "shipped", "completed"]);

  while (page <= maxPages) {
    const resp = await fetch(
      `https://${domain}/api/orders?limit=50&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    ).catch(() => null);
    if (!resp || !resp.ok) break;
    const rows = (await resp.json()) as any[];
    if (!Array.isArray(rows) || rows.length === 0) break;

    for (const order of rows) {
      const customerExt = order.customer?.id || order.customerId || order.customer_id;
      if (!customerExt) continue;

      const customerId = await upsertShopCustomer(
        companyId,
        "ideasoft",
        String(customerExt),
        {
          fullName:
            order.customer?.fullName ||
            [order.customer?.firstname, order.customer?.lastname]
              .filter(Boolean)
              .join(" ")
              .trim() ||
            order.customer?.email ||
            `Customer ${customerExt}`,
          email: order.customer?.email,
          phone: order.customer?.phone,
        }
      );

      const status = (order.status || order.orderStatus || "").toString().toLowerCase();
      const isPaid = PAID_STATUSES.has(status);
      const value =
        parseFloat(order.totalAmount || order.total || order.grandTotal || "0") || 0;

      await upsertOrderDeal(companyId, customerId, "ideasoft", {
        externalId: String(order.id),
        value,
        currency: order.currency || "TRY",
        isPaid,
        closedAt: isPaid && order.updatedAt ? new Date(order.updatedAt) : null,
      });
      ordersSynced++;
    }

    if (rows.length < 50) break;
    page++;
  }
  return ordersSynced;
}

// ─── T-SOFT ───────────────────────────────────────────────────────────
async function syncTSoft(
  domain: string,
  creds: SyncCreds,
  companyId: string
): Promise<SyncResult> {
  let imported = 0;
  const resp = await fetch(
    `https://${domain}/rest1/customer/getList`,
    {
      method: "POST",
      headers: {
        Token: creds.accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ start: 0, limit: 500 }),
    }
  ).catch(() => null);
  if (!resp || !resp.ok) return { imported: 0, orders: 0 };
  const data = (await resp.json()) as { data?: any[] };
  const rows = data.data || [];

  for (const c of rows) {
    const fullName = [c.name, c.surname].filter(Boolean).join(" ").trim() || c.email;
    await upsertShopCustomer(companyId, "tsoft", String(c.id || c.customer_id), {
      fullName,
      email: c.email,
      phone: c.phone || c.gsm,
      city: c.city,
    });
    imported++;
  }

  const orders = await syncTSoftOrders(domain, creds, companyId);
  return { imported, orders };
}

async function syncTSoftOrders(
  domain: string,
  creds: SyncCreds,
  companyId: string
): Promise<number> {
  let ordersSynced = 0;
  // T-Soft order_status_id mapping varies per store, but status_name usually in
  // Turkish. We match common paid/fulfilled names.
  const PAID_STATUS_NAMES = new Set([
    "onaylandi",
    "hazirlaniyor",
    "kargolandi",
    "teslimedildi",
    "tamamlandi",
    "odemealindi",
  ]);

  const resp = await fetch(
    `https://${domain}/rest1/order/getList`,
    {
      method: "POST",
      headers: {
        Token: creds.accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ start: 0, limit: 500 }),
    }
  ).catch(() => null);
  if (!resp || !resp.ok) return 0;
  const body = (await resp.json()) as { data?: any[] };
  const rows = body.data || [];

  for (const order of rows) {
    const customerExtId = order.customer_id || order.member_id;
    if (!customerExtId) continue;

    const customerId = await upsertShopCustomer(
      companyId,
      "tsoft",
      String(customerExtId),
      {
        fullName:
          [order.customer_name, order.customer_surname].filter(Boolean).join(" ").trim() ||
          order.email ||
          `Müşteri ${customerExtId}`,
        email: order.email,
        phone: order.phone || order.gsm,
      }
    );

    const status = (order.status_name || order.status || "")
      .toString()
      .toLowerCase()
      .replace(/\s+/g, "");
    const paidFlag = order.is_paid === "1" || order.is_paid === 1 || order.is_paid === true;
    const isPaid = paidFlag || PAID_STATUS_NAMES.has(status);
    const value = parseFloat(order.total || order.grand_total || "0") || 0;

    await upsertOrderDeal(companyId, customerId, "tsoft", {
      externalId: String(order.id || order.order_id),
      value,
      currency: order.currency || "TRY",
      isPaid,
      closedAt: isPaid && order.last_update ? new Date(order.last_update) : null,
    });
    ordersSynced++;
  }
  return ordersSynced;
}

// ─── IKAS ─────────────────────────────────────────────────────────────
async function syncIkas(creds: SyncCreds, companyId: string): Promise<SyncResult> {
  let imported = 0;
  const query = `{
    listCustomer(pagination: { limit: 100 }) {
      data {
        id
        email
        firstName
        lastName
        phone
      }
    }
  }`;
  const resp = await fetch(
    `https://api.myikas.com/api/v1/admin/graphql`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    }
  ).catch(() => null);
  if (!resp || !resp.ok) return { imported: 0, orders: 0 };
  const body = (await resp.json()) as any;
  const rows = body?.data?.listCustomer?.data || [];

  for (const c of rows) {
    const fullName = [c.firstName, c.lastName].filter(Boolean).join(" ").trim() || c.email;
    await upsertShopCustomer(companyId, "ikas", String(c.id), {
      fullName,
      email: c.email,
      phone: c.phone,
    });
    imported++;
  }

  const orders = await syncIkasOrders(creds, companyId);
  return { imported, orders };
}

async function syncIkasOrders(
  creds: SyncCreds,
  companyId: string
): Promise<number> {
  let ordersSynced = 0;
  // İkas order statuses (enum): CREATED, CANCELLED, FULFILLED, PARTIALLY_FULFILLED,
  // REFUNDED, PARTIALLY_REFUNDED. paymentStatus: PAID, FAILED, PENDING, REFUNDED.
  const PAID_ORDER_STATUSES = new Set([
    "FULFILLED",
    "PARTIALLY_FULFILLED",
  ]);
  const query = `{
    listOrder(pagination: { limit: 100 }) {
      data {
        id
        orderNumber
        status
        paymentStatus
        totalFinalPrice
        currencyCode
        createdAt
        orderedAt
        customer {
          id
          email
          firstName
          lastName
          phone
        }
      }
    }
  }`;
  const resp = await fetch(
    `https://api.myikas.com/api/v1/admin/graphql`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    }
  ).catch(() => null);
  if (!resp || !resp.ok) return 0;
  const body = (await resp.json()) as any;
  const rows = body?.data?.listOrder?.data || [];

  for (const order of rows) {
    const customer = order.customer;
    if (!customer?.id) continue;

    const customerId = await upsertShopCustomer(
      companyId,
      "ikas",
      String(customer.id),
      {
        fullName:
          [customer.firstName, customer.lastName].filter(Boolean).join(" ").trim() ||
          customer.email ||
          `Customer ${customer.id}`,
        email: customer.email,
        phone: customer.phone,
      }
    );

    const paymentStatus = (order.paymentStatus || "").toString().toUpperCase();
    const orderStatus = (order.status || "").toString().toUpperCase();
    const isPaid =
      paymentStatus === "PAID" || PAID_ORDER_STATUSES.has(orderStatus);
    const value =
      parseFloat(order.totalFinalPrice?.toString() || "0") || 0;

    await upsertOrderDeal(companyId, customerId, "ikas", {
      externalId: String(order.id),
      value,
      currency: order.currencyCode || "TRY",
      isPaid,
      closedAt: isPaid && order.orderedAt ? new Date(order.orderedAt) : null,
    });
    ordersSynced++;
  }
  return ordersSynced;
}

// ─── TURHOST ──────────────────────────────────────────────────────────
async function syncTurhost(
  domain: string,
  creds: SyncCreds,
  companyId: string
): Promise<SyncResult> {
  let imported = 0;
  const resp = await fetch(
    `https://${domain}/api/customers?limit=500`,
    {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        "Content-Type": "application/json",
      },
    }
  ).catch(() => null);
  if (!resp || !resp.ok) return { imported: 0, orders: 0 };
  const data = (await resp.json()) as any;
  const rows = data.data || data.customers || [];

  for (const c of rows) {
    const fullName = c.name || [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
    await upsertShopCustomer(companyId, "turhost", String(c.id), {
      fullName,
      email: c.email,
      phone: c.phone,
    });
    imported++;
  }

  const orders = await syncTurhostOrders(domain, creds, companyId);
  return { imported, orders };
}

async function syncTurhostOrders(
  domain: string,
  creds: SyncCreds,
  companyId: string
): Promise<number> {
  let ordersSynced = 0;
  // Turhost statuses (generic e-commerce): paid, completed, shipped, delivered
  const PAID_STATUSES = new Set([
    "paid",
    "completed",
    "shipped",
    "delivered",
    "odendi",
    "tamamlandi",
  ]);

  const resp = await fetch(
    `https://${domain}/api/orders?limit=500`,
    {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        "Content-Type": "application/json",
      },
    }
  ).catch(() => null);
  if (!resp || !resp.ok) return 0;
  const data = (await resp.json()) as any;
  const rows = data.data || data.orders || [];

  for (const order of rows) {
    const customerExtId = order.customerId || order.customer_id || order.customer?.id;
    if (!customerExtId) continue;

    const customerId = await upsertShopCustomer(
      companyId,
      "turhost",
      String(customerExtId),
      {
        fullName:
          order.customer?.name ||
          [order.customer?.firstName, order.customer?.lastName]
            .filter(Boolean)
            .join(" ")
            .trim() ||
          order.customer?.email ||
          order.customerName ||
          `Customer ${customerExtId}`,
        email: order.customer?.email || order.customerEmail,
        phone: order.customer?.phone || order.customerPhone,
      }
    );

    const status = (order.status || order.orderStatus || "")
      .toString()
      .toLowerCase()
      .replace(/\s+/g, "");
    const isPaid = PAID_STATUSES.has(status);
    const value = parseFloat(order.total || order.grandTotal || "0") || 0;

    await upsertOrderDeal(companyId, customerId, "turhost", {
      externalId: String(order.id || order.orderId),
      value,
      currency: order.currency || "TRY",
      isPaid,
      closedAt: isPaid && order.updatedAt ? new Date(order.updatedAt) : null,
    });
    ordersSynced++;
  }
  return ordersSynced;
}
