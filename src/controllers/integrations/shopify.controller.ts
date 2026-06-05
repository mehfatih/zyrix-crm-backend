import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../../types";
import { prisma } from "../../config/database";
import {
  createState,
  consumeState,
} from "../../services/oauth-state.service";
import {
  buildAuthorizeUrl,
  validateShopDomain,
  verifyHmac,
  exchangeCodeForToken,
  grantedScopesSatisfy,
  missingOptionalScopes,
  CORE_RESOURCES,
  signState,
  verifySignedState,
  STATE_COOKIE_NAME,
} from "../../services/shopify/oauth";
import {
  isShopifyConfigured,
  getWebAppUrl,
  getMobileScheme,
} from "../../services/shopify/config";
import {
  upsertConnectionTokens,
  listConnections,
  getConnectionById,
  getConnection,
  deleteConnection,
  setStatus,
  getValidAccessToken,
  type ShopifyConnectionRow,
} from "../../services/shopify/connections.service";
import { triggerInitialSync, runShopifySync } from "../../services/shopify/sync";
import { integrationError } from "../../lib/errors/integrationErrors";
import {
  recordIntegrationEvent,
  countEventsByType,
  avgSyncDurationMs,
  recentFailures,
} from "../../services/integration-events.service";
import { recordAudit, extractRequestMeta } from "../../utils/audit";
import { getApiVersion } from "../../services/shopify/config";

// ============================================================================
// SHOPIFY INTEGRATION CONTROLLER (/api/integrations/shopify)
// ----------------------------------------------------------------------------
// OAuth 2.0 authorization-code grant, offline + expiring tokens, encrypted at
// rest. The callback is the only public route; it identifies the company via
// the oauth_states row (+ a signed state cookie as defense-in-depth).
// ============================================================================

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

const TIMESTAMP_TOLERANCE_SEC = 600; // 10 min — bounds replay; HMAC+state are primary

// ──────────────────────────────────────────────────────────────────────
// POST /connect — body { shop }, optional ?platform=mobile
// Returns { authorizeUrl } for the client to navigate to.
// ──────────────────────────────────────────────────────────────────────
export async function connect(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, companyId } = auth(req);

    if (!isShopifyConfigured()) {
      throw integrationError(
        "SHOPIFY_NOT_CONFIGURED",
        "Shopify OAuth is not configured on this deployment",
        { companyId }
      );
    }

    const shopInput =
      typeof req.body?.shop === "string"
        ? req.body.shop
        : typeof req.query.shop === "string"
        ? req.query.shop
        : "";
    const shopDomain = validateShopDomain(shopInput); // throws INVALID_SHOP_DOMAIN

    const platform = req.query.platform === "mobile" ? "mobile" : "web";

    const state = await createState({
      provider: "shopify",
      companyId,
      userId,
      returnUrl: "/integrations/shopify",
      metadata: { shopDomain, platform },
    });

    // Signed, short-lived, httpOnly cookie carrying the same nonce (CSRF
    // defense-in-depth alongside the DB state row).
    res.cookie(STATE_COOKIE_NAME, signState(state), {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 15 * 60 * 1000,
      path: "/api/integrations/shopify",
    });

    await recordIntegrationEvent({
      companyId,
      eventType: "oauth_start",
      requestContext: { shop: shopDomain, userId, platform, route: req.originalUrl },
    });

    const authorizeUrl = buildAuthorizeUrl(shopDomain, state);
    return res.status(200).json({ success: true, data: { authorizeUrl } });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// GET /callback — PUBLIC. Shopify redirects the merchant's browser here.
// All failures redirect back to web/mobile with ?status=error&code=...
// ──────────────────────────────────────────────────────────────────────
function returnTarget(platform: "web" | "mobile"): { ok: string; err: (code: string) => string } {
  if (platform === "mobile") {
    const scheme = getMobileScheme(); // e.g. "zyrix://"
    return {
      ok: `${scheme}shopify/connected?status=connected`,
      err: (code) => `${scheme}shopify/connected?status=error&code=${encodeURIComponent(code)}`,
    };
  }
  const base = getWebAppUrl();
  return {
    ok: `${base}/integrations/shopify?status=connected`,
    err: (code) => `${base}/integrations/shopify?status=error&code=${encodeURIComponent(code)}`,
  };
}

export async function callback(req: Request, res: Response) {
  // Default platform=web until we read the state metadata.
  let platform: "web" | "mobile" = "web";
  let companyIdForLog: string | null = null;

  const fail = async (code: string, message: string, shop?: string) => {
    await recordIntegrationEvent({
      companyId: companyIdForLog,
      eventType: "oauth_failure",
      errorCode: code,
      errorMessage: message,
      requestContext: { shop, route: req.originalUrl, requestId: (req as { id?: string }).id },
    });
    return res.redirect(returnTarget(platform).err(code));
  };

  try {
    const q = req.query as Record<string, unknown>;
    if (q.error) {
      return fail("SHOPIFY_AUTH_FAILED", `Merchant cancelled or Shopify error: ${String(q.error)}`);
    }

    const code = typeof q.code === "string" ? q.code : "";
    const state = typeof q.state === "string" ? q.state : "";
    const shopParam = typeof q.shop === "string" ? q.shop : "";

    if (!code || !state || !shopParam) {
      return fail("SHOPIFY_AUTH_FAILED", "Missing code/state/shop in callback");
    }

    // 1) HMAC (before any DB work — cheap rejection of forged callbacks).
    if (!verifyHmac(q)) {
      return fail("INVALID_HMAC", "Callback HMAC verification failed", shopParam);
    }

    // 2) Shop domain shape.
    let shopDomain: string;
    try {
      shopDomain = validateShopDomain(shopParam);
    } catch {
      return fail("INVALID_SHOP_DOMAIN", `Invalid shop in callback: ${shopParam}`, shopParam);
    }

    // 3) Timestamp tolerance.
    const ts = typeof q.timestamp === "string" ? parseInt(q.timestamp, 10) : NaN;
    if (!Number.isNaN(ts)) {
      const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
      if (skew > TIMESTAMP_TOLERANCE_SEC) {
        return fail("SHOPIFY_AUTH_FAILED", `Callback timestamp outside tolerance (${skew}s)`, shopDomain);
      }
    }

    // 4) State nonce — one-shot DB row.
    const consumed = await consumeState(state);
    if (!consumed || consumed.provider !== "shopify") {
      return fail("INVALID_STATE", "OAuth state expired, reused, or unknown", shopDomain);
    }
    companyIdForLog = consumed.companyId;
    platform = (consumed.metadata as { platform?: string }).platform === "mobile" ? "mobile" : "web";

    // 5) Signed state cookie (defense-in-depth). Only enforced when present —
    //    a mobile in-app browser or cross-device start may not carry it; the
    //    DB state row above is the authoritative check.
    const cookieVal = readCookie(req, STATE_COOKIE_NAME);
    if (cookieVal && !verifySignedState(cookieVal, state)) {
      return fail("INVALID_STATE", "State cookie mismatch", shopDomain);
    }

    // 6) The shop in the callback is the store's CANONICAL *.myshopify.com
    //    domain, which can legitimately differ from the handle the merchant
    //    typed at install (e.g. an alias like "levana-cosmetics-2" whose
    //    canonical domain is "kgs1qk-h4.myshopify.com"). The HMAC above has
    //    already cryptographically verified this callback belongs to
    //    `shopDomain`, so we trust it and store the connection under the
    //    canonical shop. We do NOT hard-fail on a mismatch with the typed
    //    handle — that rejected valid alias installs.
    const expectedShop = String((consumed.metadata as { shopDomain?: string }).shopDomain ?? "");
    if (expectedShop && expectedShop !== shopDomain) {
      console.warn(
        `[shopify] callback shop ${shopDomain} differs from install handle ${expectedShop} ` +
          `(alias → canonical); proceeding with the HMAC-verified callback shop`
      );
    }

    // 7) Exchange code → expiring offline token set.
    const tokens = await exchangeCodeForToken(shopDomain, code);

    // 8) Verify granted scopes ⊇ required (merchant can tamper with scope).
    if (!grantedScopesSatisfy(tokens.scope)) {
      return fail(
        "MISSING_PERMISSIONS",
        `Insufficient scopes — granted: [${tokens.scope}]; required core read access: [${CORE_RESOURCES.join(", ")}] (read_X or write_X)`,
        shopDomain
      );
    }
    // Every other requested scope is OPTIONAL — a non-grant is logged here and
    // never blocks the connection (protects merchants from scope-name
    // mismatches / partial grants).
    const optMissing = missingOptionalScopes(tokens.scope);
    if (optMissing.length) {
      console.warn(
        `[shopify] ${shopDomain} connected WITHOUT optional scopes (non-blocking): ${optMissing.join(", ")}`
      );
    }

    // 9) Encrypt + store (one active record per company+shop).
    const connectionId = await upsertConnectionTokens({
      companyId: consumed.companyId,
      shopDomain,
      tokens,
    });

    // Clear the state cookie now that it's consumed.
    res.clearCookie(STATE_COOKIE_NAME, { path: "/api/integrations/shopify" });

    await recordIntegrationEvent({
      companyId: consumed.companyId,
      eventType: "oauth_success",
      requestContext: { shop: shopDomain, connectionId, platform, scopes: tokens.scope },
    });
    await recordAudit({
      userId: consumed.userId,
      companyId: consumed.companyId,
      action: "integration.shopify.connected",
      entityType: "shopify_connection",
      entityId: connectionId,
      metadata: { shopDomain, platform },
      ...extractRequestMeta(req),
    });

    // 10) Kick off initial sync (detached) and redirect.
    const conn = await getConnection(consumed.companyId, shopDomain);
    if (conn) triggerInitialSync(conn);

    return res.redirect(returnTarget(platform).ok);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return fail(e.code ?? "INTERNAL_ERROR", e.message ?? "Unexpected callback error");
  }
}

// ──────────────────────────────────────────────────────────────────────
// GET /status — connection state(s) for the current company. Never tokens.
// Includes legacy manual-token shopify stores flagged 'legacy_manual'.
// ──────────────────────────────────────────────────────────────────────
export async function status(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const rows = await listConnections(companyId);
    const connections = rows.map(publicConnectionShape);

    // Legacy manual-token / old-OAuth shopify stores (additive migration §8).
    const legacyStores = await prisma.ecommerceStore.findMany({
      where: { companyId, platform: "shopify" },
      select: {
        id: true,
        shopDomain: true,
        isActive: true,
        lastSyncAt: true,
        syncStatus: true,
      },
    });
    const connectedDomains = new Set(rows.map((r) => r.shopDomain));
    const legacy = legacyStores
      .filter((s) => !connectedDomains.has(s.shopDomain))
      .map((s) => ({
        id: s.id,
        shopDomain: s.shopDomain,
        status: "legacy_manual" as const,
        isActive: s.isActive,
        lastSyncAt: s.lastSyncAt,
        syncStatus: s.syncStatus,
      }));

    res.status(200).json({
      success: true,
      data: { configured: isShopifyConfigured(), connections, legacy },
    });
  } catch (err) {
    next(err);
  }
}

function publicConnectionShape(r: ShopifyConnectionRow) {
  return {
    id: r.id,
    shopDomain: r.shopDomain,
    status: r.status,
    scopes: r.scopes ? r.scopes.split(",") : [],
    lastSyncAt: r.lastSyncAt,
    lastSyncDurationMs: r.lastSyncDurationMs,
    tokenExpiresAt: r.tokenExpiresAt,
    needsReauth: r.status === "needs_reauth",
    lastError: r.lastError,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ──────────────────────────────────────────────────────────────────────
// POST /disconnect — body { id }. Best-effort remote revoke, then local
// delete + audit + event.
// ──────────────────────────────────────────────────────────────────────
export async function disconnect(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, companyId } = auth(req);
    const id = typeof req.body?.id === "string" ? req.body.id : "";
    const conn = await getConnectionById(companyId, id);
    if (!conn) {
      throw integrationError("STORE_NOT_FOUND", "Connection not found", { companyId });
    }

    await setStatus(conn.id, "revoked");
    await bestEffortRemoteRevoke(conn);
    await deleteConnection(companyId, conn.id);

    await recordIntegrationEvent({
      companyId,
      eventType: "disconnect",
      requestContext: { shop: conn.shopDomain, connectionId: conn.id },
    });
    await recordAudit({
      userId,
      companyId,
      action: "integration.shopify.disconnected",
      entityType: "shopify_connection",
      entityId: conn.id,
      metadata: { shopDomain: conn.shopDomain },
      ...extractRequestMeta(req),
    });

    res.status(200).json({ success: true, data: { disconnected: true } });
  } catch (err) {
    next(err);
  }
}

async function bestEffortRemoteRevoke(conn: ShopifyConnectionRow): Promise<void> {
  try {
    const token = await getValidAccessToken(conn);
    await fetch(`https://${conn.shopDomain}/admin/api/${getApiVersion()}/api_permissions/current.json`, {
      method: "DELETE",
      headers: { "X-Shopify-Access-Token": token },
    });
  } catch {
    // Non-fatal — the merchant may also uninstall from their admin. We still
    // remove the local record either way.
  }
}

// ──────────────────────────────────────────────────────────────────────
// GET /health — aggregated metrics for the Integration Health Dashboard.
// ──────────────────────────────────────────────────────────────────────
export async function health(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const windowHours = req.query.window === "7d" ? 24 * 7 : 24;

    const rows = await listConnections(companyId);
    const byStatus = { connected: 0, needs_reauth: 0, error: 0, revoked: 0, pending: 0 };
    for (const r of rows) {
      if (r.status in byStatus) (byStatus as Record<string, number>)[r.status]++;
    }

    const counts = await countEventsByType(companyId, "shopify", windowHours);
    const avgSync = await avgSyncDurationMs(companyId, "shopify", windowHours);
    const failures = await recentFailures(companyId, "shopify", 10);

    res.status(200).json({
      success: true,
      data: {
        windowHours,
        connections: {
          total: rows.length,
          ...byStatus,
        },
        lastSyncByShop: rows.map((r) => ({
          shopDomain: r.shopDomain,
          lastSyncAt: r.lastSyncAt,
          lastSyncDurationMs: r.lastSyncDurationMs,
          status: r.status,
        })),
        avgSyncDurationMs: avgSync,
        oauthSuccess: counts.oauth_success ?? 0,
        oauthFailures: counts.oauth_failure ?? 0,
        tokenRefreshes: counts.token_refresh ?? 0,
        tokenRefreshFailures: counts.token_refresh_failure ?? 0,
        syncSuccess: counts.sync_success ?? 0,
        syncFailures: counts.sync_failure ?? 0,
        apiFailures: counts.api_failure ?? 0,
        recentFailures: failures,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// GET /products — imported Shopify products for the current company.
// ──────────────────────────────────────────────────────────────────────
export async function products(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const limit = Math.min(
      Math.max(parseInt(String(req.query.limit ?? "120"), 10) || 120, 1),
      250
    );
    const rows = await prisma.$queryRawUnsafe(
      `SELECT "id","externalId","title","handle","vendor","productType","status",
              "variantsCount","sku","price"::text AS "price","inventoryQuantity","imageUrl","updatedAt"
         FROM shopify_products
        WHERE "companyId" = $1
        ORDER BY "updatedAt" DESC
        LIMIT $2`,
      companyId,
      limit
    );
    const totalRow = (await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM shopify_products WHERE "companyId" = $1`,
      companyId
    )) as Array<{ n: number }>;
    res.status(200).json({
      success: true,
      data: { products: rows, total: totalRow[0]?.n ?? 0 },
    });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// POST /resync — run a sync now for every connected store of this company.
// Refreshes per-store currency and re-stamps bridged catalog products
// (also the one-time backfill for products imported before currency support).
// Awaited so the response reflects the result.
// ──────────────────────────────────────────────────────────────────────
export async function resync(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const conns = await listConnections(companyId);
    const connected = conns.filter((c) => c.status === "connected");
    if (connected.length === 0) {
      res.status(400).json({
        success: false,
        error: { message: "No connected Shopify store to sync" },
      });
      return;
    }
    const synced: Array<Record<string, unknown>> = [];
    for (const conn of connected) {
      const r = await runShopifySync(conn);
      synced.push(
        r
          ? { shopDomain: conn.shopDomain, ok: true, ...r }
          : { shopDomain: conn.shopDomain, ok: false }
      );
    }
    res.status(200).json({
      success: true,
      data: { synced },
      message: "Resync complete",
    });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Minimal cookie reader (cookie-parser isn't installed). Parses the raw
// Cookie header for a single named value.
// ──────────────────────────────────────────────────────────────────────
function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}
