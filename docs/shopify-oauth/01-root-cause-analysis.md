# 01 — Root Cause Analysis

## Problem 1 — Manual-token Shopify onboarding doesn't scale & isn't future-proof

The pre-sprint Shopify integration had two code paths:

1. **Manual token entry** (`ecommerce.service.ts` + the settings catalog): the merchant
   pastes an Admin API `shpat_…` token. Friction-heavy, error-prone, and Shopify is
   retiring this model.
2. **Legacy OAuth** (`controllers/oauth.controller.ts`, `services/oauth/shopify.adapter.ts`,
   route `/api/oauth/shopify`). Functional but built on the **wrong** model:

| Gap | Evidence (pre-sprint) | Risk |
|---|---|---|
| Online token, not offline | `buildInstallUrl` sent `grant_options[]=per-user` | Token tied to a user session — background sync breaks when nobody is logged in |
| Non-expiring assumption | adapter comment: *"Tokens are permanent (no refresh flow)"* | Shopify **mandates expiring offline tokens for new public apps from 2026-04-01**; this path would be rejected |
| **No HMAC verification** | callback never validated the `hmac` query param | A forged callback could inject an attacker-chosen `code`/`shop` |
| **No scope verification** | granted scope never compared to required | Merchant can downgrade scopes via the URL |
| **Tokens stored in plaintext** | `ecommerce_stores.accessToken` is a plain column | Token theft = full store access |
| Hardcoded API version | `2024-10` literal in 3 places | Silent breakage as versions retire |
| Generic errors | `errorHandler` fell back to *"An unexpected error occurred"* | No actionable message, no traceability |

**Conclusion:** rebuild the Shopify path as a dedicated `/api/integrations/shopify`
module using the **authorization code grant with expiring offline tokens**, encrypted at
rest, with full callback security and structured errors — additively, without breaking the
legacy path (see `04-migration-plan.md`).

## Problem 2 — Global input invisibility

Form inputs across the web app set no explicit text color and inherited a near-background
color on the navy theme, so typed text (e.g. `levanastore.com` in the store-domain field)
was effectively invisible. There was **no shared input primitive and no global form layer**
— every input was styled inline, so the bug recurred wherever a `text-*` class was omitted.
Root cause + fix in `05-input-visibility-audit.md`.
