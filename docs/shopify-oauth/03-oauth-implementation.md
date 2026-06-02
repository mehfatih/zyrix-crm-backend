# 03 — OAuth Implementation

## Endpoints (`/api/integrations/shopify`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/connect` | session | Validates `{ shop }`, sets state nonce + signed cookie, returns `{ authorizeUrl }`. `?platform=mobile` controls the final return target. |
| GET | `/callback` | **public** | Runs all security checks → exchange → encrypt+store → `oauth_success` → trigger sync → redirect to web/mobile. |
| GET | `/status` | session | Connection state(s) for the company (never tokens) + legacy stores flagged `legacy_manual`. |
| POST | `/disconnect` | session | Best-effort remote revoke, local delete, `disconnect` event. |
| GET | `/health` | session | Aggregated metrics for the Health Dashboard (`?window=24h|7d`). |

## Authorize URL (offline + expiring)

`buildAuthorizeUrl(shop, state)` →
`https://{shop}/admin/oauth/authorize?client_id&scope&redirect_uri&state&expiring=1`
— **no** `grant_options[]` (offline mode). Scopes come from `SHOPIFY_SCOPES`.

## Callback security (all must pass — else redirect with `?status=error&code=…`)

1. **HMAC** — `verifyHmac(query)`: drop `hmac`/`signature`, sort remaining `k=v` pairs
   lexicographically, join with `&`, HMAC-SHA256 hex with the API secret,
   `crypto.timingSafeEqual`.
2. **Shop domain** — `validateShopDomain`: must end `.myshopify.com`, charset `[a-z0-9.-]`,
   valid subdomain.
3. **Timestamp** — within 600 s tolerance.
4. **State nonce** — one-shot `consumeState` (15-min TTL DB row).
5. **Signed state cookie** — verified when present (defense-in-depth; absent on some
   in-app browsers, where the DB nonce is authoritative).
6. **Shop match** — callback `shop` must equal the install `shop`.

## Token exchange + refresh

`exchangeCodeForToken(shop, code)` → `POST https://{shop}/admin/oauth/access_token`
`{ client_id, client_secret, code }`. Response captured as `{ accessToken, refreshToken,
expiresInSec, refreshTokenExpiresInSec, scope }`.

`refreshAccessToken(shop, refreshToken)` → same endpoint with
`{ client_id, client_secret, grant_type: "refresh_token", refresh_token }`.

Both use a 15 s `AbortController` timeout → typed `CONNECTION_TIMEOUT`; HTTP 429 →
`RATE_LIMITED`.

## Scope verification

`grantedScopesSatisfy(scope)` — granted scopes must be a **superset** of `SHOPIFY_SCOPES`
(merchant can tamper with the scope param). Insufficient → `MISSING_PERMISSIONS`.

## Encryption at rest

`tokenCipher.ts` (AES-256-GCM, random 12-byte IV, 16-byte tag) using
`INTEGRATION_TOKEN_ENC_KEY` (32-byte base64). `connections.service` stores
`ciphertext/iv/tag` triplets for both tokens; raw tokens never hit the DB or logs.
`getValidAccessToken` decrypts in memory, refreshing + rotating if expired.

## Initial + ongoing sync

On `oauth_success`, `triggerInitialSync(connection)` runs detached. `runShopifySync`
decrypts the token in memory and reuses the shared `upsertShopCustomer` / `upsertOrderDeal`
helpers to import customers + orders (180-day window), recording
`sync_start/sync_success/sync_failure` + duration. `cron/shopify-sync.ts` repeats hourly
for `connected` connections with stale `lastSyncAt`. No plaintext token is ever persisted.
