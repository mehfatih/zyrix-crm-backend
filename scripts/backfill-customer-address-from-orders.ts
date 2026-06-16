// ============================================================================
// THROWAWAY — Backfill shipping address from ORDERS for name-only contacts
// ----------------------------------------------------------------------------
// Companion to backfill-customer-address.ts (which reads the customer PROFILE).
// This one reads each name-only contact's MOST-RECENT ORDER and fills the empty
// address columns from that order's shipping_address (fallback billing), reusing
// the exact shopifyAddressFields/wooAddressFields mappers from ecommerce.service
// — no new mapping logic. Use this when addresses live on orders, not profiles.
//
// SAFETY (identical guarantees to the profile backfill):
//   • Never overwrites a non-empty column — UPDATE uses COALESCE(NULLIF(col,''),$new).
//   • Never touches fullName / email / phone.
//   • Idempotent + safe to re-run (a filled street line drops out of candidates).
//   • Scoped per tenant; a LIVE run (--apply) MUST name one --company.
//   • Rate-limited via fetchWithLimit (same per-shop token bucket as the sync).
//
// USAGE
//   Dry-run, all reachable tenants (writes NOTHING):
//     npx tsx scripts/backfill-customer-address-from-orders.ts
//   Dry-run, one tenant:
//     npx tsx scripts/backfill-customer-address-from-orders.ts --company <id> --platform woocommerce
//   LIVE (requires --company):
//     npx tsx scripts/backfill-customer-address-from-orders.ts --company <id> --apply
//
// RAILWAY vs LOCAL
//   • WooCommerce + MANUAL Shopify stores (ecommerce_stores, plaintext creds):
//       runnable LOCALLY.
//   • Shopify OAuth tenants (shopify_connections, AES-encrypted token):
//       require INTEGRATION_TOKEN_ENC_KEY → run ON RAILWAY (or set the key
//       locally). Such tenants are auto-detected and listed under
//       "NEEDS RAILWAY" instead of being silently skipped.
// ============================================================================

import { prisma } from "../src/config/database";
import { fetchWithLimit } from "../src/utils/rateLimiter";
import {
  shopifyAddressFields,
  wooAddressFields,
  type AddressFields,
} from "../src/services/ecommerce.service";
import { getApiVersion } from "../src/services/shopify/config";
import { listConnections, getValidAccessToken } from "../src/services/shopify/connections.service";

// ── args ────────────────────────────────────────────────────────────────
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const APPLY = process.argv.includes("--apply");
const ONLY_COMPANY = arg("company");
const ONLY_PLATFORM = arg("platform");

const ADDRESS_COLS = [
  "address",
  "address2",
  "postalCode",
  "province",
  "shippingPhone",
  "country",
  "city",
] as const;
type AddrCol = (typeof ADDRESS_COLS)[number];
type AddrInfo = AddressFields & { country: string | null; city: string | null };
// allIds = every candidate customer id that has at least one order (even an
// address-less one), so we can tell "no orders" from "orders had no address".
type PullResult = { map: Map<string, AddrInfo>; allIds: Set<string> };
type CustomerRow = { id: string; externalId: string; fullName: string } & Record<AddrCol, string | null>;

const MAX_PAGES = 1000;
const UA = "ZyrixCRM-AddressBackfill/1.0";

async function fetchRetry(platform: string, domain: string, url: string, init: RequestInit, attempts = 3): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchWithLimit(platform, domain, url, init);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

function nonEmptyInfo(info: AddrInfo): boolean {
  return ADDRESS_COLS.some((c) => {
    const v = (info as any)[c] as string | null;
    return v != null && v !== "";
  });
}

// ── ORDER pulls — most-recent order's address per candidate customer ───────
// `wanted` limits work to the name-only candidate ids (keeps the map small and
// skips orders for fully-addressed customers we don't care about).
async function pullShopifyOrders(
  domain: string,
  token: string,
  version: string,
  wanted: Set<string>
): Promise<PullResult> {
  const map = new Map<string, AddrInfo>();
  const allIds = new Set<string>();
  const bestAt = new Map<string, number>(); // customerId -> newest order ts kept
  let pageInfo: string | null = null;
  let page = 0;
  while (page < MAX_PAGES) {
    const url = pageInfo
      ? `https://${domain}/admin/api/${version}/orders.json?limit=250&status=any&page_info=${encodeURIComponent(pageInfo)}`
      : `https://${domain}/admin/api/${version}/orders.json?limit=250&status=any`;
    const resp = await fetchRetry("shopify", domain, url, {
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json", "User-Agent": UA },
    });
    if (!resp.ok) {
      console.warn(`    shopify orders pull stopped: HTTP ${resp.status}`);
      break;
    }
    const data = (await resp.json()) as { orders?: any[] };
    if (!data.orders || data.orders.length === 0) break;
    for (const o of data.orders) {
      const cid = o.customer?.id;
      if (cid == null) continue;
      const key = String(cid);
      if (!wanted.has(key)) continue;
      allIds.add(key);
      const addr = o.shipping_address || o.billing_address || null;
      if (!addr) continue;
      const info: AddrInfo = { ...shopifyAddressFields(addr), country: addr.country ?? null, city: addr.city ?? null };
      if (!nonEmptyInfo(info)) continue;
      const t = Date.parse(o.created_at || o.processed_at || "") || 0;
      if (!bestAt.has(key) || t >= (bestAt.get(key) as number)) {
        bestAt.set(key, t);
        map.set(key, info);
      }
    }
    const link = resp.headers.get("link") || "";
    const m = link.match(/<[^>]*page_info=([^&>]+)[^>]*>;\s*rel="next"/);
    if (m) {
      pageInfo = decodeURIComponent(m[1]);
      page++;
      if (page === MAX_PAGES) console.warn(`    shopify orders hit MAX_PAGES (${MAX_PAGES}) — may be partial`);
    } else break;
  }
  return { map, allIds };
}

async function pullWooOrders(domain: string, auth: string, wanted: Set<string>): Promise<PullResult> {
  const map = new Map<string, AddrInfo>();
  const allIds = new Set<string>();
  let page = 1;
  // Newest-first; the FIRST order we see for a customer is their most recent.
  while (page <= MAX_PAGES) {
    const url = `https://${domain}/wp-json/wc/v3/orders?per_page=100&page=${page}&orderby=date&order=desc`;
    const resp = await fetchRetry("woocommerce", domain, url, {
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json", "User-Agent": UA },
    });
    if (!resp.ok) {
      console.warn(`    woo orders pull stopped: HTTP ${resp.status}`);
      break;
    }
    const rows = (await resp.json()) as any[];
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const o of rows) {
      const cid = o.customer_id;
      if (!cid || cid === 0) continue;
      const key = String(cid);
      if (!wanted.has(key)) continue;
      allIds.add(key);
      if (map.has(key)) continue; // already have this customer's most-recent order
      const addr = o.shipping && (o.shipping.address_1 || o.shipping.city) ? o.shipping : o.billing;
      if (!addr) continue;
      const info: AddrInfo = { ...wooAddressFields(addr), country: addr.country ?? null, city: addr.city ?? null };
      if (!nonEmptyInfo(info)) continue;
      map.set(key, info);
    }
    if (rows.length < 100) break;
    page++;
    if (page > MAX_PAGES) console.warn(`    woo orders hit MAX_PAGES (${MAX_PAGES}) — may be partial`);
  }
  return { map, allIds };
}

// ── credential resolution ─────────────────────────────────────────────────
type ShopifyCreds = { domain: string; token: string; version: string };
async function resolveShopify(companyId: string): Promise<{ creds?: ShopifyCreds; needsRailway?: boolean }> {
  const conns = await listConnections(companyId);
  const conn = conns.find((c) => c.status === "connected") || conns[0];
  let oauthLocked = false;
  if (conn) {
    try {
      const token = await getValidAccessToken(conn);
      return { creds: { domain: conn.shopDomain, token, version: getApiVersion() } };
    } catch (e) {
      const msg = (e as Error).message;
      oauthLocked = /INTEGRATION_TOKEN_ENC_KEY|decrypt|token cipher/i.test(msg);
      console.warn(`    OAuth token unavailable (${msg}); trying manual store`);
    }
  }
  const store = await prisma.ecommerceStore.findFirst({ where: { companyId, platform: "shopify", isActive: true } });
  if (store?.accessToken) return { creds: { domain: store.shopDomain, token: store.accessToken, version: getApiVersion() } };
  if (oauthLocked) return { needsRailway: true };
  return {};
}

async function resolveWoo(companyId: string): Promise<{ domain: string; auth: string } | null> {
  const store = await prisma.ecommerceStore.findFirst({ where: { companyId, platform: "woocommerce", isActive: true } });
  if (store?.apiKey && store?.apiSecret) {
    return { domain: store.shopDomain, auth: Buffer.from(`${store.apiKey}:${store.apiSecret}`).toString("base64") };
  }
  return null;
}

async function loadCandidates(companyId: string, source: string): Promise<CustomerRow[]> {
  return (await prisma.$queryRawUnsafe(
    `SELECT id, "externalId", "fullName",
            address, address2, "postalCode", province, "shippingPhone", country, city
       FROM customers
      WHERE "companyId" = $1 AND source = $2 AND "deletedAt" IS NULL
        AND (address IS NULL OR address = '')
      ORDER BY "createdAt" ASC`,
    companyId,
    source
  )) as CustomerRow[];
}

function platformIdOf(externalId: string): string {
  const i = externalId.indexOf(":");
  return i >= 0 ? externalId.slice(i + 1) : externalId;
}
function fillsFor(row: CustomerRow, info: AddrInfo): AddrCol[] {
  return ADDRESS_COLS.filter((col) => {
    const cur = row[col];
    const next = (info as any)[col] as string | null;
    return (cur === null || cur === "") && next != null && next !== "";
  });
}

// ── stats + samples ────────────────────────────────────────────────────────
interface UnitStats {
  companyId: string;
  platform: string;
  candidates: number;
  wouldUpdate: number;
  noOrders: number; // candidate has no (matched) order
  ordersNoAddr: number; // had order(s) but none carried an address
  existsNoNew: number; // order address present but nothing the row is missing
  applied: number;
  error?: string;
}
const SAMPLES: Array<{
  platform: string;
  externalId: string;
  fullName: string;
  fills: AddrCol[];
  before: Record<string, string | null>;
  after: Record<string, string | null>;
}> = [];

async function processUnit(
  companyId: string,
  platform: string,
  source: string,
  pull: (wanted: Set<string>) => Promise<PullResult>
): Promise<UnitStats> {
  const stats: UnitStats = {
    companyId, platform, candidates: 0, wouldUpdate: 0, noOrders: 0, ordersNoAddr: 0, existsNoNew: 0, applied: 0,
  };
  const candidates = await loadCandidates(companyId, source);
  stats.candidates = candidates.length;
  if (candidates.length === 0) return stats;

  const wanted = new Set(candidates.map((c) => platformIdOf(c.externalId)));
  console.log(`  [${companyId}] ${platform}: ${candidates.length} name-only candidate(s) — pulling orders…`);
  let map: Map<string, AddrInfo>;
  let allIds: Set<string>;
  try {
    ({ map, allIds } = await pull(wanted));
  } catch (e) {
    stats.error = (e as Error).message;
    console.warn(`    pull FAILED (${stats.error}) — candidates reported, updates not computed`);
    return stats;
  }
  console.log(`    matched ${allIds.size} candidate(s) with orders, ${map.size} with an order address`);

  for (const row of candidates) {
    const pid = platformIdOf(row.externalId);
    if (!allIds.has(pid)) {
      stats.noOrders++;
      continue;
    }
    const info = map.get(pid);
    if (!info) {
      stats.ordersNoAddr++;
      continue;
    }
    const fills = fillsFor(row, info);
    if (fills.length === 0) {
      stats.existsNoNew++;
      continue;
    }
    stats.wouldUpdate++;

    if (SAMPLES.length < 5) {
      const before: Record<string, string | null> = {};
      const after: Record<string, string | null> = {};
      for (const col of ADDRESS_COLS) {
        before[col] = row[col];
        const cur = row[col];
        after[col] = cur === null || cur === "" ? ((info as any)[col] ?? null) : cur;
      }
      SAMPLES.push({ platform, externalId: row.externalId, fullName: row.fullName, fills, before, after });
    }

    if (APPLY) {
      await prisma.$executeRawUnsafe(
        `UPDATE customers SET
           address         = COALESCE(NULLIF(address, ''), $1),
           address2        = COALESCE(NULLIF(address2, ''), $2),
           "postalCode"    = COALESCE(NULLIF("postalCode", ''), $3),
           province        = COALESCE(NULLIF(province, ''), $4),
           "shippingPhone" = COALESCE(NULLIF("shippingPhone", ''), $5),
           country         = COALESCE(NULLIF(country, ''), $6),
           city            = COALESCE(NULLIF(city, ''), $7),
           "updatedAt"     = NOW()
         WHERE id = $8`,
        info.address, info.address2, info.postalCode, info.province, info.shippingPhone,
        info.country, info.city, row.id
      );
      stats.applied++;
    }
  }
  return stats;
}

// ── tenant enumeration ─────────────────────────────────────────────────────
async function shopifyCompanies(): Promise<Set<string>> {
  const set = new Set<string>();
  const conn = (await prisma.$queryRawUnsafe(`SELECT DISTINCT "companyId" FROM shopify_connections`)) as Array<{ companyId: string }>;
  conn.forEach((r) => set.add(r.companyId));
  const stores = await prisma.ecommerceStore.findMany({ where: { platform: "shopify" }, select: { companyId: true } });
  stores.forEach((s) => set.add(s.companyId));
  return set;
}
async function wooCompanies(): Promise<Set<string>> {
  const set = new Set<string>();
  const stores = await prisma.ecommerceStore.findMany({ where: { platform: "woocommerce" }, select: { companyId: true } });
  stores.forEach((s) => set.add(s.companyId));
  return set;
}

function show(v: string | null): string {
  return v === null || v === "" ? "∅" : v;
}

async function main(): Promise<void> {
  if (APPLY && !ONLY_COMPANY) {
    console.error("REFUSING: a LIVE run (--apply) must be scoped to one tenant via --company <id>.");
    process.exit(2);
  }

  console.log("============================================================");
  console.log(`Order-based address backfill — ${APPLY ? "LIVE (--apply)" : "DRY-RUN (no writes)"}`);
  console.log(`Scope: company=${ONLY_COMPANY ?? "ALL"}  platform=${ONLY_PLATFORM ?? "shopify+woocommerce"}`);
  console.log("============================================================\n");

  const stats: UnitStats[] = [];
  const needsRailway: string[] = [];

  if (!ONLY_PLATFORM || ONLY_PLATFORM === "shopify") {
    let companies = [...(await shopifyCompanies())];
    if (ONLY_COMPANY) companies = companies.filter((c) => c === ONLY_COMPANY);
    for (const companyId of companies) {
      const r = await resolveShopify(companyId);
      if (r.needsRailway) {
        needsRailway.push(companyId);
        console.log(`  [${companyId}] shopify: OAuth token locked locally — NEEDS RAILWAY`);
        continue;
      }
      if (!r.creds) {
        console.log(`  [${companyId}] shopify: no usable credentials — skipped`);
        continue;
      }
      const creds = r.creds;
      stats.push(await processUnit(companyId, "shopify", "shopify", (w) => pullShopifyOrders(creds.domain, creds.token, creds.version, w)));
    }
  }

  if (!ONLY_PLATFORM || ONLY_PLATFORM === "woocommerce") {
    let companies = [...(await wooCompanies())];
    if (ONLY_COMPANY) companies = companies.filter((c) => c === ONLY_COMPANY);
    for (const companyId of companies) {
      const creds = await resolveWoo(companyId);
      if (!creds) {
        console.log(`  [${companyId}] woocommerce: no usable credentials — skipped`);
        continue;
      }
      stats.push(await processUnit(companyId, "woocommerce", "woocommerce", (w) => pullWooOrders(creds.domain, creds.auth, w)));
    }
  }

  const tot = stats.reduce(
    (a, s) => ({
      candidates: a.candidates + s.candidates,
      wouldUpdate: a.wouldUpdate + s.wouldUpdate,
      noOrders: a.noOrders + s.noOrders,
      ordersNoAddr: a.ordersNoAddr + s.ordersNoAddr,
      existsNoNew: a.existsNoNew + s.existsNoNew,
      applied: a.applied + s.applied,
    }),
    { candidates: 0, wouldUpdate: 0, noOrders: 0, ordersNoAddr: 0, existsNoNew: 0, applied: 0 }
  );

  console.log("\n──────────────── PER-TENANT ────────────────");
  for (const s of stats.filter((s) => s.candidates > 0)) {
    console.log(
      `  ${s.platform.padEnd(11)} ${s.companyId}  candidates=${s.candidates} wouldUpdate=${s.wouldUpdate} ` +
        `noOrders=${s.noOrders} ordersNoAddr=${s.ordersNoAddr} existsNoNew=${s.existsNoNew}` +
        `${APPLY ? ` applied=${s.applied}` : ""}${s.error ? `  ⚠ PULL FAILED: ${s.error}` : ""}`
    );
  }

  if (SAMPLES.length) {
    console.log("\n──────────────── SAMPLES (before → after) ────────────────");
    for (const s of SAMPLES) {
      console.log(`\n  ${s.platform} ${s.externalId} — ${s.fullName}`);
      console.log(`    fills: ${s.fills.join(", ")}`);
      for (const col of ADDRESS_COLS) {
        if (s.before[col] !== s.after[col]) {
          console.log(`      ${col.padEnd(14)} ${show(s.before[col])}  →  ${show(s.after[col])}`);
        }
      }
    }
  }

  console.log("\n──────────────── TOTALS ────────────────");
  console.log(`  candidates (name-only):        ${tot.candidates}`);
  console.log(`  WOULD update:                  ${tot.wouldUpdate}`);
  console.log(`  no matched order:              ${tot.noOrders}`);
  console.log(`  orders had no address:         ${tot.ordersNoAddr}`);
  console.log(`  order addr, nothing new:       ${tot.existsNoNew}`);
  if (APPLY) console.log(`  APPLIED (rows written):        ${tot.applied}`);

  if (needsRailway.length) {
    console.log("\n──────────────── NEEDS RAILWAY (run there with the enc key) ────────────────");
    for (const c of needsRailway) console.log(`  shopify ${c}  — INTEGRATION_TOKEN_ENC_KEY required to decrypt the OAuth token`);
  }

  console.log(
    APPLY
      ? `\nLIVE run complete — ${tot.applied} contact(s) enriched.`
      : `\nDRY-RUN complete — NOTHING written. Re-run with --company <id> --apply to enrich one tenant.`
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
