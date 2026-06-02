# 02 — Architecture Decision

## Decision

Replace manual `shpat_…` token entry with the **OAuth 2.0 Authorization Code Grant**,
issuing an **expiring offline access token + refresh token**, stored **AES-256-GCM
encrypted** server-side. The merchant only ever types a store domain.

## Why this, not the alternatives

- **Token exchange** is only for apps **embedded in the Shopify admin** (it exchanges an
  App Bridge session token). Zyrix CRM is a **standalone, non-embedded** app → token
  exchange doesn't apply. Authorization code grant is the correct flow.
- **Client credentials grant** is only for apps acting on **your own** org's store, not for
  connecting arbitrary merchant stores.
- **Offline (per-shop) token, not online (per-user):** the CRM syncs orders/products/
  customers in the **background** when no merchant is logged in. Online tokens are
  short-lived and tied to a user session → we **omit** `grant_options[]=per-user`.
- **Expiring offline tokens are mandatory:** As of **2026-04-01** Shopify requires all new
  public apps to use expiring offline tokens with a refresh flow (access token ~1h,
  refresh token ~90d, rotated each refresh; all public apps by 2027-01-01). We send
  `expiring=1` on authorize + exchange and implement refresh + rotation from day one.

## Token lifecycle

1. Before any Admin API call, `getValidAccessToken(connection)` checks `tokenExpiresAt`.
   If expired/near-expiry (2-min skew), it refreshes via the rotating refresh token and
   persists the new token set atomically.
2. On a revocation-type refresh failure → connection marked `needs_reauth`, UI prompts a
   reconnect (never silently loops).
3. Issuance / refresh / refresh-failure are logged to `integration_events` **without** raw
   token values.

## Data model (additive, raw SQL)

- **`shopify_connections`** — one active record per `(companyId, shopDomain)`. Encrypted
  access + refresh token triplets (`ciphertext/iv/tag`), `tokenExpiresAt`,
  `refreshTokenExpiresAt`, `scopes`, `status`, sync stats.
- **`integration_events`** — centralized health log (oauth/token/sync lifecycle), jsonb
  `requestContext`, no secrets.
- **State** — reuse the existing `oauth_states` row (15-min one-shot nonce) **plus** a
  signed, httpOnly state cookie as defense-in-depth.

`companyId` is the tenant key throughout (confirmed in recon — not workspaceId/merchantId).

## Module layout (backend)

```
config/env.ts                         + SHOPIFY_* / INTEGRATION_TOKEN_ENC_KEY / MOBILE_DEEP_LINK_SCHEME
lib/crypto/tokenCipher.ts             AES-256-GCM encrypt/decrypt
lib/errors/integrationErrors.ts       stable codes → i18n keys → AppError
middleware/requestId.ts               uuid per request (X-Request-Id)
services/integration-events.service   recordIntegrationEvent + health aggregations
services/shopify/config.ts            credential/scope/version/redirect resolver (API_KEY ?? CLIENT_ID)
services/shopify/oauth.ts             authorize / HMAC / validate / exchange(expiring=1) / refresh / state cookie
services/shopify/connections.service  encrypt+persist, getValidAccessToken (refresh+rotate)
services/shopify/sync.ts              initial + ongoing sync (encrypted token, in-memory only)
controllers/integrations/shopify.controller.ts   connect / callback / status / disconnect / health
routes/integrations/shopify.routes.ts            mounted at /api/integrations/shopify
cron/shopify-sync.ts                  hourly sync of due connections
```
