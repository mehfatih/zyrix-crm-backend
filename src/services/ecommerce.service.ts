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
  return { imported, orders: 0 };
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
  return { imported, orders: 0 };
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
  return { imported, orders: 0 };
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
  return { imported, orders: 0 };
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
      country: c.Ulke || "Turkey",
    });
    imported++;
  }
  return { imported, orders: 0 };
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
  return { imported, orders: 0 };
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
  return { imported, orders: 0 };
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
  return { imported, orders: 0 };
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
  return { imported, orders: 0 };
}
