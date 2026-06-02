# 06 — Error / Logging / Monitoring

## Stable error codes → i18n keys

Defined in `lib/errors/integrationErrors.ts`. Every integration failure throws an `AppError`
built via `integrationError(code, devMessage, context)` carrying `{ code, httpStatus,
category, userMessageKey, context }`. The frontend localizes `userMessageKey` under the
`IntegrationErrors` (web) / `integrationErrors` (mobile) namespace.

| Code | HTTP | Category | i18n key |
|---|---|---|---|
| `SHOPIFY_NOT_CONFIGURED` | 501 | config | `IntegrationErrors.SHOPIFY_NOT_CONFIGURED` |
| `SHOPIFY_AUTH_FAILED` | 401 | oauth | `IntegrationErrors.SHOPIFY_AUTH_FAILED` |
| `SHOPIFY_CODE_EXCHANGE_FAILED` | 502 | oauth | `IntegrationErrors.SHOPIFY_CODE_EXCHANGE_FAILED` |
| `STORE_NOT_FOUND` | 404 | oauth | `IntegrationErrors.STORE_NOT_FOUND` |
| `MISSING_PERMISSIONS` | 403 | oauth | `IntegrationErrors.MISSING_PERMISSIONS` |
| `INVALID_SHOP_DOMAIN` | 400 | validation | `IntegrationErrors.INVALID_SHOP_DOMAIN` |
| `INVALID_STATE` | 400 | oauth | `IntegrationErrors.INVALID_STATE` |
| `INVALID_HMAC` | 400 | oauth | `IntegrationErrors.INVALID_HMAC` |
| `RATE_LIMITED` | 429 | upstream | `IntegrationErrors.RATE_LIMITED` |
| `CONNECTION_TIMEOUT` | 504 | upstream | `IntegrationErrors.CONNECTION_TIMEOUT` |
| `TOKEN_REFRESH_FAILED` | 502 | token | `IntegrationErrors.TOKEN_REFRESH_FAILED` |
| `NEEDS_REAUTH` | 409 | token | `IntegrationErrors.NEEDS_REAUTH` |
| `INTERNAL_ERROR` | 500 | upstream | `IntegrationErrors.INTERNAL_ERROR` |

## Request tracing

`middleware/requestId.ts` assigns a uuid per request (honoring an inbound `X-Request-Id`),
echoes `X-Request-Id`, and the error handler includes `requestId` in **every** error body
(`{ success:false, requestId, error:{ code, message, userMessageKey, requestId } }`). The
generic *"An unexpected error occurred"* now always ships with a `requestId` to correlate
with Railway logs.

## integration_events log

`recordIntegrationEvent(...)` writes one row per lifecycle event
(`oauth_start|oauth_success|oauth_failure|token_refresh|token_refresh_failure|
sync_start|sync_success|sync_failure|disconnect|api_failure`). Fire-and-forget (never breaks
the primary flow). A `SECRET_KEYS` denylist strips `access_token/refresh_token/code/hmac/
secret/…` from `requestContext` even if a caller forgets. The central error middleware also
auto-logs `AppError`s whose context marks an integration failure.

## Health dashboard feed

`GET /api/integrations/shopify/health` aggregates from `integration_events` +
`shopify_connections`: connections by status, last sync per shop, avg sync duration,
oauth/sync/token-refresh success+failure counts (24h/7d window), and a recent-failures feed.
Consumed by the web Integration Health Dashboard (`components/integrations/
ShopifyHealthDashboard.tsx`).

## What is never logged

Raw access/refresh tokens, the `hmac` value, the API secret, the auth `code`, the encryption
key. Token cipher returns hex and callers never log the decrypted value.
