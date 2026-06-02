# 07 — Rollout Plan

## 1. Partner Dashboard (human, one-time)

- Create/confirm a **public app**.
- App URL: `https://crm.zyrix.co`
- Allowed redirect URL: `https://api.crm.zyrix.co/api/integrations/shopify/callback`
- Enable **expiring offline access tokens**.
- Scopes (read-only start): `read_products, read_orders, read_customers, read_inventory,
  read_fulfillments`.
- Capture **Client ID** + **Client secret**.

## 2. Railway env (service `zyrix-crm-backend`)

```
SHOPIFY_API_KEY=<Client ID>
SHOPIFY_API_SECRET=<Client secret>
SHOPIFY_SCOPES=read_products,read_orders,read_customers,read_inventory,read_fulfillments
SHOPIFY_APP_URL=https://crm.zyrix.co
SHOPIFY_REDIRECT_URI=https://api.crm.zyrix.co/api/integrations/shopify/callback
SHOPIFY_API_VERSION=2026-04          # bump to 2026-07 on/after 2026-07-01
INTEGRATION_TOKEN_ENC_KEY=<openssl rand -base64 32>
MOBILE_DEEP_LINK_SCHEME=zyrix://
```

> `INTEGRATION_TOKEN_ENC_KEY` is **load-bearing** — rotating it invalidates all stored
> tokens (merchants must reconnect). Store it as a protected secret.

## 3. Database (raw SQL — per Zyrix Prisma rules)

Run `prisma/migrations/2026-06_shopify_oauth_hardening.sql` in Railway → Data → Query
(idempotent). Locally: `npx prisma db push --accept-data-loss` + `npx prisma generate`.
**Do not** run `prisma migrate deploy/dev`.

## 4. Deploy order

1. Backend (route is inert until secrets are added — safe to deploy first).
2. Add Railway secrets + run SQL.
3. Web (Vercel) — no new secret needed (uses existing `NEXT_PUBLIC_API_URL`).
4. Mobile — `app.json` scheme stays `zyrix` (no change).

## 5. Verify in production

- Connect the Levana test store (web + mobile): domain → consent → `?status=connected` →
  encrypted tokens in `shopify_connections` → initial sync imports customers/orders.
- Force-expire a token → confirm refresh + rotation; force a refresh failure → confirm
  `needs_reauth` + reconnect CTA.
- Health dashboard shows real counts; `integration_events` rows carry no secrets.

## 6. Quarterly maintenance

Bump `SHOPIFY_API_VERSION` each quarter (Jan/Apr/Jul/Oct), one version behind latest is fine
within the 12-month support window.
