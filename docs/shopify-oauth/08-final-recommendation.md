# 08 — Final Recommendation

**Adopt the OAuth 2.0 authorization code grant with expiring offline tokens, encrypted at
rest, as the single Shopify onboarding path for Zyrix CRM.** It is the strongest, most
scalable, most future-proof choice for connecting thousands of merchant stores.

## Why it's the strongest choice

- **Security first.** The merchant never handles a token. Tokens are AES-256-GCM encrypted
  at rest; the callback enforces HMAC, state nonce + signed cookie, shop-domain validation,
  timestamp tolerance, and scope verification. Nothing sensitive is logged.
- **Customer experience.** One field (store domain) + one click. No "create a private app,
  grant scopes, copy a `shpat_…` token" ritual. Errors are localized and actionable
  (en/ar/tr) with a `requestId`.
- **Scalability.** Per-shop offline tokens sync in the background with no merchant session.
  Refresh + rotation run automatically; `needs_reauth` cleanly handles revocation. The
  hourly connection-sync cron scales to hundreds of stores per tick with a polite delay.
- **Maintainability.** One typed error registry, one cipher util, one events log powering a
  real health dashboard. `companyId` tenancy matches the rest of the platform. The legacy
  path stays working during migration and is removed later without risk.
- **Future Shopify compatibility.** Built directly on the **expiring offline token** model
  Shopify mandates for new public apps (2026-04-01; all public apps by 2027-01-01). The API
  version is env-driven (`2026-04`), so quarterly upgrades are a config change, not a code
  change.

## Net effect

Zyrix moves from a brittle, manual, plaintext, soon-to-be-rejected token model to a secure,
one-click, self-healing OAuth integration that is ready for thousands of stores and aligned
with where Shopify is going — shipped additively with zero disruption to existing merchants.
