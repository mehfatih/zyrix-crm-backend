import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types";
import { env } from "../config/env";
import { prisma } from "../config/database";
import {
  createState,
  consumeState,
  type OAuthProvider,
} from "../services/oauth-state.service";
import * as salla from "../services/oauth/salla.adapter";
import * as shopify from "../services/oauth/shopify.adapter";
import { recordAudit, extractRequestMeta } from "../utils/audit";

// ============================================================================
// OAUTH CONTROLLER
// ----------------------------------------------------------------------------
// Three route groups:
//   /api/oauth/:provider/install   — session-auth required, kicks off flow
//   /api/oauth/:provider/callback  — NO auth (public), finishes the flow
//   /api/oauth/connections         — session-auth, lists installed stores
//
// The callback deliberately has no auth because it's the provider's
// redirect landing — the merchant's browser comes back from Salla/Shopify
// carrying a ?code + ?state. We identify them by looking up the state
// row, not by session cookies (which may not even be present if the
// merchant started the flow from within Salla's admin).
// ============================================================================

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return {
    userId: r.user.userId,
    companyId: r.user.companyId,
  };
}

function frontendUrl(path: string): string {
  const base = env.FRONTEND_URL.replace(/\/$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

// ──────────────────────────────────────────────────────────────────────
// INSTALL — /api/oauth/:provider/install
// ──────────────────────────────────────────────────────────────────────

export async function install(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const provider = req.params.provider as OAuthProvider;
    const { userId, companyId } = auth(req);
    const returnUrl =
      typeof req.query.returnUrl === "string"
        ? req.query.returnUrl
        : "/integrations";

    if (provider === "salla") {
      if (!salla.isSallaConfigured()) {
        return res.status(501).json({
          success: false,
          error: {
            code: "SALLA_NOT_CONFIGURED",
            message: "Salla integration is not yet available — check back soon.",
          },
        });
      }
      const state = await createState({
        provider: "salla",
        companyId,
        userId,
        returnUrl,
      });
      const url = salla.buildInstallUrl(state);
      await recordAudit({
        userId,
        companyId,
        action: "oauth.install_initiated",
        entityType: "ecommerce_store",
        entityId: null,
        metadata: { provider: "salla" },
        ...extractRequestMeta(req),
      });
      // Return JSON so the frontend can do window.location.href = url
      // (XHR with Bearer can't follow a 302 across origin boundaries to
      // accounts.salla.sa, so we hand the URL to the client and let the
      // browser navigate directly).
      return res.status(200).json({ success: true, data: { url } });
    }

    if (provider === "shopify") {
      if (!shopify.isShopifyConfigured()) {
        return res.status(501).json({
          success: false,
          error: {
            code: "SHOPIFY_NOT_CONFIGURED",
            message: "Shopify integration is not yet available — check back soon.",
          },
        });
      }
      // Shopify requires the shop domain at install time (the consent
      // URL is per-shop). We accept it as ?shop=my-store.myshopify.com.
      const shopInput =
        typeof req.query.shop === "string" ? req.query.shop : "";
      const shopDomain = shopify.normalizeShopDomain(shopInput);
      if (!shopDomain) {
        return res.status(400).json({
          success: false,
          error: {
            code: "INVALID_SHOP",
            message:
              "Missing or invalid ?shop= parameter. Must be <handle>.myshopify.com",
          },
        });
      }
      const state = await createState({
        provider: "shopify",
        companyId,
        userId,
        returnUrl,
        metadata: { shopDomain },
      });
      const url = shopify.buildInstallUrl(shopDomain, state);
      await recordAudit({
        userId,
        companyId,
        action: "oauth.install_initiated",
        entityType: "ecommerce_store",
        entityId: null,
        metadata: { provider: "shopify", shopDomain },
        ...extractRequestMeta(req),
      });
      return res.status(200).json({ success: true, data: { url } });
    }

    return res.status(400).json({
      success: false,
      error: {
        code: "UNKNOWN_PROVIDER",
        message: `Unknown OAuth provider: ${provider}`,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// CALLBACK — /api/oauth/:provider/callback
// No session auth — we identify the company via the state row.
// ──────────────────────────────────────────────────────────────────────

export async function callback(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const provider = req.params.provider as OAuthProvider;
    const code =
      typeof req.query.code === "string" ? req.query.code : undefined;
    const state =
      typeof req.query.state === "string" ? req.query.state : undefined;

    // Some providers send ?error= on user-cancelled flows
    if (req.query.error) {
      return res.redirect(
        frontendUrl(
          `/integrations?error=${encodeURIComponent(String(req.query.error))}`
        )
      );
    }

    if (!code || !state) {
      return res.status(400).send(
        "Missing code or state in callback. This page shouldn't be opened directly."
      );
    }

    const consumed = await consumeState(state);
    if (!consumed) {
      return res.redirect(
        frontendUrl(
          `/integrations?error=invalid_state&message=${encodeURIComponent(
            "The install link expired or was already used. Please start again."
          )}`
        )
      );
    }

    if (consumed.provider !== provider) {
      return res.redirect(
        frontendUrl(
          `/integrations?error=provider_mismatch`
        )
      );
    }

    if (provider === "salla") {
      const tokens = await salla.exchangeCode(code);
      const info = await salla.fetchStoreInfo(tokens.accessToken);
      const shopDomain = info.domain || String(info.id);

      // Upsert by (companyId, platform='salla', shopDomain) so reinstall
      // refreshes the token instead of creating a duplicate row.
      const existing = await prisma.ecommerceStore.findFirst({
        where: {
          companyId: consumed.companyId,
          platform: "salla",
          shopDomain,
        },
        select: { id: true },
      });

      if (existing) {
        await prisma.ecommerceStore.update({
          where: { id: existing.id },
          data: {
            accessToken: tokens.accessToken,
            apiSecret: tokens.refreshToken ?? undefined,
            currency: info.currency ?? undefined,
            metadata: {
              storeId: info.id,
              storeName: info.name,
              email: info.email,
              refreshedAt: new Date().toISOString(),
            } as any,
            isActive: true,
            syncStatus: "idle",
            syncError: null,
          },
        });
      } else {
        await prisma.ecommerceStore.create({
          data: {
            companyId: consumed.companyId,
            platform: "salla",
            shopDomain,
            accessToken: tokens.accessToken,
            apiSecret: tokens.refreshToken ?? null,
            currency: info.currency,
            metadata: {
              storeId: info.id,
              storeName: info.name,
              email: info.email,
              installedAt: new Date().toISOString(),
            } as any,
            isActive: true,
          },
        });
      }

      await recordAudit({
        userId: consumed.userId,
        companyId: consumed.companyId,
        action: "oauth.install_completed",
        entityType: "ecommerce_store",
        entityId: null,
        metadata: { provider: "salla", shopDomain: info.domain, storeName: info.name },
        ...extractRequestMeta(req),
      });

      return res.redirect(
        frontendUrl(`${consumed.returnUrl}?connected=salla&store=${encodeURIComponent(info.name)}`)
      );
    }

    if (provider === "shopify") {
      const shopDomain = String(
        (consumed.metadata as any).shopDomain ?? ""
      );
      if (!shopDomain) {
        return res.redirect(
          frontendUrl(`/integrations?error=missing_shop`)
        );
      }
      const tokens = await shopify.exchangeCode(shopDomain, code);
      const info = await shopify.fetchShopInfo(shopDomain, tokens.accessToken);

      const existing = await prisma.ecommerceStore.findFirst({
        where: {
          companyId: consumed.companyId,
          platform: "shopify",
          shopDomain,
        },
        select: { id: true },
      });

      if (existing) {
        await prisma.ecommerceStore.update({
          where: { id: existing.id },
          data: {
            accessToken: tokens.accessToken,
            currency: info.currency ?? undefined,
            metadata: {
              storeId: info.id,
              storeName: info.name,
              email: info.email,
              country: info.countryName,
              refreshedAt: new Date().toISOString(),
            } as any,
            isActive: true,
            syncStatus: "idle",
            syncError: null,
          },
        });
      } else {
        await prisma.ecommerceStore.create({
          data: {
            companyId: consumed.companyId,
            platform: "shopify",
            shopDomain,
            accessToken: tokens.accessToken,
            currency: info.currency,
            metadata: {
              storeId: info.id,
              storeName: info.name,
              email: info.email,
              country: info.countryName,
              installedAt: new Date().toISOString(),
            } as any,
            isActive: true,
          },
        });
      }

      await recordAudit({
        userId: consumed.userId,
        companyId: consumed.companyId,
        action: "oauth.install_completed",
        entityType: "ecommerce_store",
        entityId: null,
        metadata: { provider: "shopify", shopDomain, storeName: info.name },
        ...extractRequestMeta(req),
      });

      return res.redirect(
        frontendUrl(`${consumed.returnUrl}?connected=shopify&store=${encodeURIComponent(info.name)}`)
      );
    }

    return res.status(400).send("Unknown provider");
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// LIST CONNECTIONS — /api/oauth/connections
// ──────────────────────────────────────────────────────────────────────

export async function listConnections(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const stores = await prisma.ecommerceStore.findMany({
      where: { companyId },
      orderBy: { lastSyncAt: "desc" },
      select: {
        id: true,
        platform: true,
        shopDomain: true,
        isActive: true,
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
    res.status(200).json({ success: true, data: stores });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// PROVIDER STATUS — /api/oauth/providers
// Tells the frontend which providers are configured in this deployment
// so it can hide Install buttons for ones that aren't available yet.
// ──────────────────────────────────────────────────────────────────────

export function providerStatus(_req: Request, res: Response) {
  res.status(200).json({
    success: true,
    data: {
      salla: salla.isSallaConfigured(),
      shopify: shopify.isShopifyConfigured(),
    },
  });
}

// ──────────────────────────────────────────────────────────────────────
// DISCONNECT — DELETE /api/oauth/connections/:id
// ──────────────────────────────────────────────────────────────────────

export async function disconnect(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const id = req.params.id as string;
    const existing = await prisma.ecommerceStore.findFirst({
      where: { id, companyId },
      select: { id: true, platform: true, shopDomain: true },
    });
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: {
          code: "NOT_FOUND",
          message: "Store connection not found",
        },
      });
    }
    await prisma.ecommerceStore.delete({ where: { id } });
    await recordAudit({
      userId,
      companyId,
      action: "oauth.disconnect",
      entityType: "ecommerce_store",
      entityId: id,
      metadata: {
        provider: existing.platform,
        shopDomain: existing.shopDomain,
      },
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data: { disconnected: true } });
  } catch (err) {
    next(err);
  }
}
