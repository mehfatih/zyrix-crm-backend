# 04 — Migration Plan (manual token → OAuth)

Additive, zero-downtime. No legacy column or table is dropped in this sprint.

1. **Ship alongside.** The new `/api/integrations/shopify` module runs next to the legacy
   `/api/oauth/shopify` path and the manual-token catalog. Currently-connected stores keep
   working untouched.
2. **New tables only.** `2026-06_shopify_oauth_hardening.sql` creates
   `shopify_connections` + `integration_events` (`IF NOT EXISTS`). It does **not** touch
   `ecommerce_stores` or `oauth_states`.
3. **Surface legacy stores.** `GET /status` returns any `ecommerce_stores` shopify rows not
   yet re-connected, flagged `legacy_manual`, with a **"Reconnect via Shopify"** CTA in web
   + mobile.
4. **Verify in prod** with at least one real store (e.g. the Levana test store). Confirm:
   connect → encrypted tokens → initial sync → refresh after expiry → `needs_reauth` on a
   forced refresh failure.
5. **Deprecate manual UI** (later): once OAuth is proven, hide the manual access-token field
   behind a flag. Code can remain temporarily.
6. **Cleanup sprint** (not this one): once all active stores are migrated, drop the
   manual-token columns/paths.

## Backward compatibility

- Credentials resolve as `SHOPIFY_API_KEY ?? SHOPIFY_CLIENT_ID` (and secret) so the legacy
  env vars keep the old path working; you only add the new names when ready.
- The new module is **inert** until `SHOPIFY_API_KEY` + `SHOPIFY_API_SECRET` +
  `INTEGRATION_TOKEN_ENC_KEY` are present (`isShopifyConfigured()` → typed
  `SHOPIFY_NOT_CONFIGURED` otherwise). Safe to deploy before the secrets are added.

## Rollback

Remove the two env secrets → `/connect` returns `SHOPIFY_NOT_CONFIGURED`; the legacy path
and existing stores are unaffected. The new tables can remain empty with no impact.
