import { prisma } from "../config/database";
import { notFound } from "../middleware/errorHandler";

// ============================================================================
// SHOPIFY INTEGRATION SERVICE
// Import customers and orders from Shopify store via Admin API
// ============================================================================

export interface ConnectStoreDto {
  shopDomain: string;
  accessToken: string;
}

export interface ShopifyCustomer {
  id: number;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  total_spent: string;
  orders_count: number;
  tags: string;
  addresses: any[];
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShopifyOrder {
  id: number;
  order_number: number;
  email: string | null;
  total_price: string;
  currency: string;
  financial_status: string;
  fulfillment_status: string | null;
  created_at: string;
  customer: { id: number } | null;
  line_items: { title: string; quantity: number; price: string }[];
}

// ──────────────────────────────────────────────────────────────────────
// STORE CRUD
// ──────────────────────────────────────────────────────────────────────
export async function listStores(companyId: string) {
  const stores = await prisma.shopifyStore.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
    // Never expose the access token to the client
    select: {
      id: true,
      shopDomain: true,
      isActive: true,
      lastSyncAt: true,
      syncStatus: true,
      syncError: true,
      totalCustomersImported: true,
      totalOrdersImported: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return stores;
}

export async function connectStore(
  companyId: string,
  dto: ConnectStoreDto
) {
  // Normalize domain (strip https://, trailing slash, www.)
  const domain = dto.shopDomain
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .replace(/^www\./, "")
    .toLowerCase();

  if (!/\.myshopify\.com$/.test(domain) && !/\./.test(domain)) {
    const err: any = new Error(
      "Invalid shop domain. Must be like 'shop-name.myshopify.com'"
    );
    err.statusCode = 400;
    throw err;
  }

  // Verify credentials with a simple /shop call
  try {
    const resp = await fetch(`https://${domain}/admin/api/2024-10/shop.json`, {
      headers: {
        "X-Shopify-Access-Token": dto.accessToken,
        "Content-Type": "application/json",
      },
    });
    if (!resp.ok) {
      const err: any = new Error(
        "Could not connect to Shopify. Check the access token."
      );
      err.statusCode = 400;
      throw err;
    }
  } catch (e: any) {
    if (e.statusCode) throw e;
    const err: any = new Error("Failed to reach Shopify servers");
    err.statusCode = 400;
    throw err;
  }

  // Upsert
  return prisma.shopifyStore.upsert({
    where: {
      companyId_shopDomain: { companyId, shopDomain: domain },
    },
    create: {
      companyId,
      shopDomain: domain,
      accessToken: dto.accessToken,
      isActive: true,
      syncStatus: "idle",
    },
    update: {
      accessToken: dto.accessToken,
      isActive: true,
      syncStatus: "idle",
      syncError: null,
    },
    select: {
      id: true,
      shopDomain: true,
      isActive: true,
      syncStatus: true,
      createdAt: true,
    },
  });
}

export async function disconnectStore(companyId: string, id: string) {
  const store = await prisma.shopifyStore.findFirst({
    where: { id, companyId },
    select: { id: true },
  });
  if (!store) throw notFound("Store");
  await prisma.shopifyStore.delete({ where: { id } });
  return { deleted: true };
}

// ──────────────────────────────────────────────────────────────────────
// SYNC
// ──────────────────────────────────────────────────────────────────────
export async function syncStore(companyId: string, id: string) {
  const store = await prisma.shopifyStore.findFirst({
    where: { id, companyId, isActive: true },
  });
  if (!store) throw notFound("Store");

  // Mark as syncing
  await prisma.shopifyStore.update({
    where: { id },
    data: { syncStatus: "syncing", syncError: null },
  });

  let importedCount = 0;
  let ordersCount = 0;

  try {
    // Fetch all customers (paginated)
    let pageInfo: string | null = null;
    let page = 0;
    const maxPages = 20; // up to 5000 customers per sync

    while (page < maxPages) {
      const url: string = pageInfo
        ? `https://${store.shopDomain}/admin/api/2024-10/customers.json?limit=250&page_info=${encodeURIComponent(pageInfo)}`
        : `https://${store.shopDomain}/admin/api/2024-10/customers.json?limit=250`;
      const resp = await fetch(url, {
        headers: {
          "X-Shopify-Access-Token": store.accessToken,
          "Content-Type": "application/json",
        },
      });
      if (!resp.ok) break;
      const data = (await resp.json()) as { customers: ShopifyCustomer[] };
      if (!data.customers || data.customers.length === 0) break;

      for (const sc of data.customers) {
        const fullName =
          [sc.first_name, sc.last_name].filter(Boolean).join(" ").trim() ||
          sc.email ||
          `Customer ${sc.id}`;
        const address = sc.addresses?.[0];

        await prisma.customer.upsert({
          where: {
            // Use externalId match if exists
            // Note: no unique compound key yet — we check manually
            id: "__never__",
          },
          create: {
            companyId,
            fullName,
            email: sc.email?.toLowerCase() || null,
            phone: sc.phone || null,
            address: address
              ? [address.address1, address.city, address.country]
                  .filter(Boolean)
                  .join(", ")
              : null,
            country: address?.country || null,
            city: address?.city || null,
            notes: sc.note || null,
            source: "shopify",
            externalId: `shopify:${sc.id}`,
            lifetimeValue: parseFloat(sc.total_spent) || 0,
            status: "customer",
          },
          update: {
            lifetimeValue: parseFloat(sc.total_spent) || 0,
            email: sc.email?.toLowerCase() || null,
            phone: sc.phone || null,
            notes: sc.note || null,
          },
        }).catch(async () => {
          // Fallback: find by externalId
          const existing = await prisma.customer.findFirst({
            where: { companyId, externalId: `shopify:${sc.id}` },
            select: { id: true },
          });
          if (existing) {
            await prisma.customer.update({
              where: { id: existing.id },
              data: {
                lifetimeValue: parseFloat(sc.total_spent) || 0,
                email: sc.email?.toLowerCase() || null,
                phone: sc.phone || null,
                notes: sc.note || null,
              },
            });
          } else {
            await prisma.customer.create({
              data: {
                companyId,
                fullName,
                email: sc.email?.toLowerCase() || null,
                phone: sc.phone || null,
                address: address
                  ? [address.address1, address.city, address.country]
                      .filter(Boolean)
                      .join(", ")
                  : null,
                country: address?.country || null,
                city: address?.city || null,
                notes: sc.note || null,
                source: "shopify",
                externalId: `shopify:${sc.id}`,
                lifetimeValue: parseFloat(sc.total_spent) || 0,
                status: "customer",
              },
            });
          }
        });
        importedCount++;
      }

      // Pagination via Link header
      const linkHeader = resp.headers.get("link") || "";
      const nextMatch = linkHeader.match(
        /<[^>]*page_info=([^&>]+)[^>]*>;\s*rel="next"/
      );
      if (nextMatch) {
        pageInfo = decodeURIComponent(nextMatch[1]);
        page++;
      } else {
        break;
      }
    }

    await prisma.shopifyStore.update({
      where: { id },
      data: {
        syncStatus: "success",
        lastSyncAt: new Date(),
        totalCustomersImported: {
          increment: importedCount,
        },
        totalOrdersImported: { increment: ordersCount },
      },
    });
  } catch (e: any) {
    await prisma.shopifyStore.update({
      where: { id },
      data: {
        syncStatus: "error",
        syncError: e.message || "Unknown error",
      },
    });
    throw e;
  }

  return {
    imported: importedCount,
    orders: ordersCount,
  };
}
