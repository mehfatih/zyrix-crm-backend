// ============================================================================
// INTEGRATION ERROR REGISTRY
// ----------------------------------------------------------------------------
// Stable, machine-readable error codes for the integration path, each mapped
// to an i18n key the frontend localizes (en/ar/tr). Building errors through
// these factories guarantees every failure carries: a stable `code`, an
// actionable localized message key, an http status, a category (for the
// health dashboard), and structured context for logging.
//
// These subclass the shared AppError (middleware/errorHandler) so the central
// Express error middleware handles them uniformly and logs the integration
// ones to integration_events.
//
// RULE: never put tokens/secrets/hmac into `context`.
// ============================================================================

import { AppError } from "../../middleware/errorHandler";

export type IntegrationErrorCode =
  | "SHOPIFY_NOT_CONFIGURED"
  | "SHOPIFY_AUTH_FAILED"
  | "SHOPIFY_CODE_EXCHANGE_FAILED"
  | "STORE_NOT_FOUND"
  | "MISSING_PERMISSIONS"
  | "INVALID_SHOP_DOMAIN"
  | "INVALID_STATE"
  | "INVALID_HMAC"
  | "RATE_LIMITED"
  | "CONNECTION_TIMEOUT"
  | "TOKEN_REFRESH_FAILED"
  | "NEEDS_REAUTH"
  // WhatsApp
  | "WHATSAPP_NOT_CONFIGURED"
  | "WHATSAPP_SIGNATURE_INVALID"
  | "WHATSAPP_WINDOW_EXPIRED"
  | "WHATSAPP_TEMPLATE_REQUIRED"
  | "WHATSAPP_SEND_FAILED"
  // Meta Lead Ads
  | "META_LEADS_NOT_CONFIGURED"
  | "META_LEAD_SIGNATURE_INVALID"
  | "META_LEAD_FETCH_FAILED"
  | "META_LEAD_TOKEN_EXPIRED"
  | "META_LEAD_MAP_FAILED"
  | "INTERNAL_ERROR";

interface CodeSpec {
  httpStatus: number;
  category: "config" | "oauth" | "token" | "sync" | "validation" | "upstream" | "messaging";
  // i18n key under the `IntegrationErrors` namespace in the web/mobile locales.
  userMessageKey: string;
}

export const INTEGRATION_ERROR_SPECS: Record<IntegrationErrorCode, CodeSpec> = {
  SHOPIFY_NOT_CONFIGURED: {
    httpStatus: 501,
    category: "config",
    userMessageKey: "IntegrationErrors.SHOPIFY_NOT_CONFIGURED",
  },
  SHOPIFY_AUTH_FAILED: {
    httpStatus: 401,
    category: "oauth",
    userMessageKey: "IntegrationErrors.SHOPIFY_AUTH_FAILED",
  },
  SHOPIFY_CODE_EXCHANGE_FAILED: {
    httpStatus: 502,
    category: "oauth",
    userMessageKey: "IntegrationErrors.SHOPIFY_CODE_EXCHANGE_FAILED",
  },
  STORE_NOT_FOUND: {
    httpStatus: 404,
    category: "oauth",
    userMessageKey: "IntegrationErrors.STORE_NOT_FOUND",
  },
  MISSING_PERMISSIONS: {
    httpStatus: 403,
    category: "oauth",
    userMessageKey: "IntegrationErrors.MISSING_PERMISSIONS",
  },
  INVALID_SHOP_DOMAIN: {
    httpStatus: 400,
    category: "validation",
    userMessageKey: "IntegrationErrors.INVALID_SHOP_DOMAIN",
  },
  INVALID_STATE: {
    httpStatus: 400,
    category: "oauth",
    userMessageKey: "IntegrationErrors.INVALID_STATE",
  },
  INVALID_HMAC: {
    httpStatus: 400,
    category: "oauth",
    userMessageKey: "IntegrationErrors.INVALID_HMAC",
  },
  RATE_LIMITED: {
    httpStatus: 429,
    category: "upstream",
    userMessageKey: "IntegrationErrors.RATE_LIMITED",
  },
  CONNECTION_TIMEOUT: {
    httpStatus: 504,
    category: "upstream",
    userMessageKey: "IntegrationErrors.CONNECTION_TIMEOUT",
  },
  TOKEN_REFRESH_FAILED: {
    httpStatus: 502,
    category: "token",
    userMessageKey: "IntegrationErrors.TOKEN_REFRESH_FAILED",
  },
  NEEDS_REAUTH: {
    httpStatus: 409,
    category: "token",
    userMessageKey: "IntegrationErrors.NEEDS_REAUTH",
  },
  WHATSAPP_NOT_CONFIGURED: {
    httpStatus: 501,
    category: "config",
    userMessageKey: "IntegrationErrors.WHATSAPP_NOT_CONFIGURED",
  },
  WHATSAPP_SIGNATURE_INVALID: {
    httpStatus: 401,
    category: "messaging",
    userMessageKey: "IntegrationErrors.WHATSAPP_SIGNATURE_INVALID",
  },
  WHATSAPP_WINDOW_EXPIRED: {
    httpStatus: 409,
    category: "messaging",
    userMessageKey: "IntegrationErrors.WHATSAPP_WINDOW_EXPIRED",
  },
  WHATSAPP_TEMPLATE_REQUIRED: {
    httpStatus: 409,
    category: "messaging",
    userMessageKey: "IntegrationErrors.WHATSAPP_TEMPLATE_REQUIRED",
  },
  WHATSAPP_SEND_FAILED: {
    httpStatus: 502,
    category: "messaging",
    userMessageKey: "IntegrationErrors.WHATSAPP_SEND_FAILED",
  },
  META_LEADS_NOT_CONFIGURED: {
    httpStatus: 501,
    category: "config",
    userMessageKey: "IntegrationErrors.META_LEADS_NOT_CONFIGURED",
  },
  META_LEAD_SIGNATURE_INVALID: {
    httpStatus: 401,
    category: "messaging",
    userMessageKey: "IntegrationErrors.META_LEAD_SIGNATURE_INVALID",
  },
  META_LEAD_FETCH_FAILED: {
    httpStatus: 502,
    category: "upstream",
    userMessageKey: "IntegrationErrors.META_LEAD_FETCH_FAILED",
  },
  META_LEAD_TOKEN_EXPIRED: {
    httpStatus: 409,
    category: "token",
    userMessageKey: "IntegrationErrors.META_LEAD_TOKEN_EXPIRED",
  },
  META_LEAD_MAP_FAILED: {
    httpStatus: 422,
    category: "validation",
    userMessageKey: "IntegrationErrors.META_LEAD_MAP_FAILED",
  },
  INTERNAL_ERROR: {
    httpStatus: 500,
    category: "upstream",
    userMessageKey: "IntegrationErrors.INTERNAL_ERROR",
  },
};

/**
 * Build a typed integration AppError. `devMessage` is the developer-facing
 * message (logs + dev responses); the frontend should render the localized
 * string for `userMessageKey` instead.
 */
export function integrationError(
  code: IntegrationErrorCode,
  devMessage: string,
  context?: Record<string, unknown>
): AppError {
  const spec = INTEGRATION_ERROR_SPECS[code];
  return new AppError(devMessage, spec.httpStatus, code, undefined, {
    category: spec.category,
    userMessageKey: spec.userMessageKey,
    context: { platform: "shopify", ...context },
  });
}
