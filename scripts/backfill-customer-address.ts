// ============================================================================
// THROWAWAY — Backfill structured shipping address on name-only contacts
// ----------------------------------------------------------------------------
// Re-pulls each Shopify/Woo customer's address from the platform Admin API and
// fills ONLY the empty address columns on the matching CRM contact, reusing the
// exact shopifyAddressFields/wooAddressFields mappers from ecommerce.service —
// no new mapping logic.
//
// SAFETY (non-negotiable):
//   • Never overwrites a column that already has a value. The UPDATE uses
//     COALESCE(NULLIF(col,''), $new) per column, so an existing value always
//     wins and only NULL/'' columns are filled.
//   • Never touches fullName / email / phone.
//   • Idempotent + safe to re-run: a contact whose street line is filled drops
//     out of the candidate set; re-running changes nothing.
//   • Scoped per tenant (companyId). A LIVE run (--apply) MUST name one
//     --company; the unscoped form is dry-run only.
//   • Rate-limit respect: every API call goes through fetchWithLimit (the same
//     per-shop token bucket the live sync uses).
//
// USAGE
//   Dry-run, all tenants (default — writes NOTHING):
//     npx tsx scripts/backfill-customer-address.ts
//   Dry-run, one tenant / one platform:
//     npx tsx scripts/backfill-customer-address.ts --company <id> --platform shopify
//   LIVE (requires --company):
//     npx tsx scripts/backfill-customer-address.ts --company <id> --apply
//
// NOTE: covers addresses stored on the platform CUSTOMER object
// (default_address / billing|shipping). A contact whose address only ever
// existed on an ORDER (never saved to the customer) won't be reachable here.
// ============================================================================

import { prisma } from "../src/config/database";
import { fetchWithLimit } from "../src/utils/rateLimiter";
import {
  shopifyAddressFields,
  wooAddressFields,
  type AddressFields,
} from "../src/services/ecommerce.service";
import { getApiVersion } from "../src/services/shopify/config";
import {
  listConnections,
  getValidAccessToken,
} from "../src/services/shopify/connections.service";

// ── args ────────────────────────────────────────────────────────────────
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const APPLY = process.argv.includes("--apply");
const ONLY_COMPANY = arg("company");
const ONLY_PLATFORM = arg("platform"); // "shopify" | "woocommerce" | undefined

// The seven columns this backfill is allowed to fill (address-only).
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
// allIds = every platform customer id seen (even with no address), so we can
// tell "customer doesn't exist upstream" from "exists but has no saved address".
type PullResult = { map: Map<string, AddrInfo>; allIds: Set<string> };
type CustomerRow = {
  id: string;
  externalId: string;
  fullName: string;
} & Record<AddrCol, string | null>;

const MAX_PAGES = 1000; // hard backstop; we log if a store ever hits it

// Some WordPress/WooCommerce hosts reset (ECONNRESET) requests that arrive
// without a browser-ish User-Agent. Send one + retry once on a transport error.
const UA = "ZyrixCRM-AddressBackfill/1.0";

async function fetchRetry(
  platform: string,
  domain: string,
  url: string,
  init: RequestInit,
  attempts = 3
): Promise<Response> {
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

// ── platform pulls (build platformCustomerId -> address map) ──────────────
async function pullShopify(domain: string, token: string, version: string): Promise<PullResult> {
  const map = new Map<string, AddrInfo>();
  const allIds = new Set<string>();
  let pageInfo: string | null = null;
  let page = 0;
  while (page < MAX_PAGES) {
    const url = pageInfo
      ? `https://${domain}/admin/api/${version}/customers.json?limit=250&page_info=${encodeURIComponent(pageInfo)}`
      : `https://${domain}/admin/api/${version}/customers.json?limit=250`;
    const resp = await fetchRetry("shopify", domain, url, {
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json", "User-Agent": UA },
    });
    if (!resp.ok) {
      console.warn(`    shopify pull stopped: HTTP ${resp.status}`);
      break;
    }
    const data = (await resp.json()) as { customers?: any[] };
    if (!data.customers || data.customers.length === 0) break;
    for (const sc of data.customers) {
      allIds.add(String(sc.id));
      const addr = sc.default_address || sc.addresses?.[0] || null;
      if (!addr) continue;
      map.set(String(sc.id), {
        ...shopifyAddressFields(addr),
        country: addr.country ?? null,
        city: addr.city ?? null,
      });
    }
    const link = resp.headers.get("link") || "";
    const m = link.match(/<[^>]*page_info=([^&>]+)[^>]*>;\s*rel="next"/);
    if (m) {
      pageInfo = decodeURIComponent(m[1]);
      page++;
      if (page === MAX_PAGES) console.warn(`    shopify pull hit MAX_PAGES (${MAX_PAGES}) — map may be partial`);
    } else break;
  }
  return { map, allIds };
}

async function pullWoo(domain: string, auth: string): Promise<PullResult> {
  const map = new Map<string, AddrInfo>();
  const allIds = new Set<string>();
  let page = 1;
  while (page <= MAX_PAGES) {
    const url = `https://${domain}/wp-json/wc/v3/customers?per_page=100&page=${page}`;
    const resp = await fetchRetry("woocommerce", domain, url, {
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json", "User-Agent": UA },
    });
    if (!resp.ok) {
      console.warn(`    woo pull stopped: HTTP ${resp.status}`);
      break;
    }
    const rows = (await resp.json()) as any[];
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const c of rows) {
      allIds.add(String(c.id));
      const addr = c.shipping && (c.shipping.address_1 || c.shipping.city) ? c.shipping : c.billing;
      if (!addr) continue;
      map.set(String(c.id), {
        ...wooAddressFields(addr),
        country: addr.country ?? null,
        city: addr.city ?? null,
      });
    }
    if (rows.length < 100) break;
    page++;
    if (page > MAX_PAGES) console.warn(`    woo pull hit MAX_PAGES (${MAX_PAGES}) — map may be partial`);
  }
  return { map, allIds };
}

// ── credential resolution per tenant ──────────────────────────────────────
async function resolveShopify(companyId: string): Promise<{ domain: string; token: string; version: string } | null> {
  const conns = await listConnections(companyId);
  const conn = conns.find((c) => c.status === "connected") || conns[0];
  if (conn) {
    try {
      const token = await getValidAccessToken(conn);
      return { domain: conn.shopDomain, token, version: getApiVersion() };
    } catch (e) {
      console.warn(`    OAuth token unavailable (${(e as Error).message}); trying manual store`);
    }
  }
  const store = await prisma.ecommerceStore.findFirst({
    where: { companyId, platform: "shopify", isActive: true },
  });
  if (store?.accessToken) return { domain: store.shopDomain, token: store.accessToken, version: getApiVersion() };
  return null;
}

async function resolveWoo(companyId: string): Promise<{ domain: string; auth: string } | null> {
  const store = await prisma.ecommerceStore.findFirst({
    where: { companyId, platform: "woocommerce", isActive: true },
  });
  if (store?.apiKey && store?.apiSecret) {
    return { domain: store.shopDomain, auth: Buffer.from(`${store.apiKey}:${store.apiSecret}`).toString("base64") };
  }
  return null;
}

// ── candidate query: contacts with NO street line (name-only / incomplete) ─
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

// Which columns would this row gain? (current empty AND source has a value)
function fillsFor(row: CustomerRow, info: AddrInfo): AddrCol[] {
  return ADDRESS_COLS.filter((col) => {
    const cur = row[col];
    const next = (info as any)[col] as string | null;
    return (cur === null || cur === "") && next != null && next !== "";
  });
}

// ── per-(tenant,platform) processing ──────────────────────────────────────
interface UnitStats {
  companyId: string;
  platform: string;
  candidates: number;
  wouldUpdate: number;
  notFound: number; // candidate's platform customer id not present upstream at all
  existsNoAddr: number; // upstream customer exists but has NO saved address (addr only on orders)
  existsNoNew: number; // upstream has address but nothing the row is missing
  applied: number;
  error?: string; // pull/credential failure — candidates known, updates not computed
}

const SAMPLES: Array<{
  companyId: string;
  platform: string;
  externalId: string;
  fullName: string;
  fills: AddrCol[];
  before: Record<string, string | null>;
  after: Record<string, string | null>;
}> = [];

// Diagnostic: when nothing would fill, prove it — CRM current vs upstream value.
const NONEW_SAMPLES: Array<{
  platform: string;
  externalId: string;
  fullName: string;
  row: CustomerRow;
  info: AddrInfo;
}> = [];

async function processUnit(
  companyId: string,
  platform: string,
  source: string,
  pull: () => Promise<PullResult>
): Promise<UnitStats> {
  const stats: UnitStats = {
    companyId, platform, candidates: 0, wouldUpdate: 0,
    notFound: 0, existsNoAddr: 0, existsNoNew: 0, applied: 0,
  };
  const candidates = await loadCandidates(companyId, source);
  stats.candidates = candidates.length;
  if (candidates.length === 0) return stats;

  console.log(`  [${companyId}] ${platform}: ${candidates.length} name-only candidate(s) — pulling addresses…`);
  let map: Map<string, AddrInfo>;
  let allIds: Set<string>;
  try {
    ({ map, allIds } = await pull());
  } catch (e) {
    stats.error = (e as Error).message;
    console.warn(`    pull FAILED (${stats.error}) — candidates reported, updates not computed`);
    return stats;
  }
  console.log(`    pulled ${allIds.size} platform customer(s), ${map.size} with an address`);

  for (const row of candidates) {
    const pid = platformIdOf(row.externalId);
    if (!allIds.has(pid)) {
      stats.notFound++;
      continue;
    }
    const info = map.get(pid);
    if (!info) {
      stats.existsNoAddr++;
      continue;
    }
    const fills = fillsFor(row, info);
    if (fills.length === 0) {
      stats.existsNoNew++;
      if (NONEW_SAMPLES.length < 5) {
        NONEW_SAMPLES.push({ platform, externalId: row.externalId, fullName: row.fullName, row, info });
      }
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
      SAMPLES.push({ companyId, platform, externalId: row.externalId, fullName: row.fullName, fills, before, after });
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

// ── enumerate tenants that have a connector ───────────────────────────────
async function shopifyCompanies(): Promise<Set<string>> {
  const set = new Set<string>();
  const conn = (await prisma.$queryRawUnsafe(
    `SELECT DISTINCT "companyId" FROM shopify_connections`
  )) as Array<{ companyId: string }>;
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
  console.log(`Customer address backfill — ${APPLY ? "LIVE (--apply)" : "DRY-RUN (no writes)"}`);
  console.log(`Scope: company=${ONLY_COMPANY ?? "ALL"}  platform=${ONLY_PLATFORM ?? "shopify+woocommerce"}`);
  console.log("============================================================\n");

  const stats: UnitStats[] = [];

  // Shopify
  if (!ONLY_PLATFORM || ONLY_PLATFORM === "shopify") {
    let companies = [...(await shopifyCompanies())];
    if (ONLY_COMPANY) companies = companies.filter((c) => c === ONLY_COMPANY);
    for (const companyId of companies) {
      const creds = await resolveShopify(companyId);
      if (!creds) {
        console.log(`  [${companyId}] shopify: no usable credentials — skipped`);
        continue;
      }
      stats.push(
        await processUnit(companyId, "shopify", "shopify", () =>
          pullShopify(creds.domain, creds.token, creds.version)
        )
      );
    }
  }

  // WooCommerce
  if (!ONLY_PLATFORM || ONLY_PLATFORM === "woocommerce") {
    let companies = [...(await wooCompanies())];
    if (ONLY_COMPANY) companies = companies.filter((c) => c === ONLY_COMPANY);
    for (const companyId of companies) {
      const creds = await resolveWoo(companyId);
      if (!creds) {
        console.log(`  [${companyId}] woocommerce: no usable credentials — skipped`);
        continue;
      }
      stats.push(await processUnit(companyId, "woocommerce", "woocommerce", () => pullWoo(creds.domain, creds.auth)));
    }
  }

  // ── report ──────────────────────────────────────────────────────────────
  const tot = stats.reduce(
    (a, s) => ({
      candidates: a.candidates + s.candidates,
      wouldUpdate: a.wouldUpdate + s.wouldUpdate,
      notFound: a.notFound + s.notFound,
      existsNoAddr: a.existsNoAddr + s.existsNoAddr,
      existsNoNew: a.existsNoNew + s.existsNoNew,
      applied: a.applied + s.applied,
    }),
    { candidates: 0, wouldUpdate: 0, notFound: 0, existsNoAddr: 0, existsNoNew: 0, applied: 0 }
  );

  console.log("\n──────────────── PER-TENANT ────────────────");
  for (const s of stats.filter((s) => s.candidates > 0)) {
    console.log(
      `  ${s.platform.padEnd(11)} ${s.companyId}  candidates=${s.candidates} wouldUpdate=${s.wouldUpdate} ` +
        `notFound=${s.notFound} existsNoAddr=${s.existsNoAddr} existsNoNew=${s.existsNoNew}` +
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

  if (!SAMPLES.length && NONEW_SAMPLES.length) {
    console.log("\n──────────────── WHY 0 FILLS (CRM now │ upstream) ────────────────");
    for (const s of NONEW_SAMPLES) {
      console.log(`\n  ${s.platform} ${s.externalId} — ${s.fullName}`);
      for (const col of ADDRESS_COLS) {
        console.log(`      ${col.padEnd(14)} CRM=${show(s.row[col])}   │   upstream=${show((s.info as any)[col] ?? null)}`);
      }
    }
  }

  console.log("\n──────────────── TOTALS ────────────────");
  console.log(`  candidates (name-only):        ${tot.candidates}`);
  console.log(`  WOULD update:                  ${tot.wouldUpdate}`);
  console.log(`  upstream id not found:         ${tot.notFound}`);
  console.log(`  upstream exists, no address:   ${tot.existsNoAddr}  (address only on orders)`);
  console.log(`  upstream addr, nothing new:    ${tot.existsNoNew}`);
  if (APPLY) console.log(`  APPLIED (rows written):        ${tot.applied}`);
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
