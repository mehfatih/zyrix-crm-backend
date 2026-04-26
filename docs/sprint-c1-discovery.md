# Sprint C1 — Discovery: `/api/brand`, `/api/brands`, `/api/brands/stats`

**Date:** 2026-04-26
**Scope:** Read-only audit of the two brand surfaces. No code, schema, or
package changes. Findings only — anything that "looks broken" is logged in
the [Open questions](#open-questions) section, not fixed.

---

## 1. Surface map

There are **two distinct brand modules** living side-by-side in the codebase
that share the `settings:branding` permission but are otherwise
unrelated.

| Mount | Routes file | Controller | Service | Backing table |
|---|---|---|---|---|
| `/api/brand` | `src/routes/brand.routes.ts` | `src/controllers/brand.controller.ts` | `src/services/brand.service.ts` | `brand_settings` (Prisma model `BrandSettings`, 1:1 with Company) |
| `/api/brands` | `src/routes/brands.routes.ts` | `src/controllers/brands.controller.ts` | `src/services/brands.service.ts` | `brands` (Prisma model `Brand`, 1:N under Company) |

Both are wired in `src/index.ts`:

- L46 / L204 → `app.use("/api/brand", brandRoutes);`
- L50 / L208 → `app.use("/api/brands", brandsRoutes);`

The two modules are **not** consolidated; they own different domains:

- `/api/brand` (singular) — **white-label settings** for the company itself
  (display name, logo, colors, custom domain, email-from). One row per
  company.
- `/api/brands` (plural) — **multi-brand catalog** so a merchant can tag
  customers/deals/activities with one of several brand labels under one
  Zyrix account.

---

## 2. Endpoint inventory

### `/api/brand` (white-label settings)

| Method | Path | Auth | Permission | Tier gate | Handler |
|---|---|---|---|---|---|
| GET | `/api/brand/public?domain=` | none (public) | — | — | `brand.controller.getPublic` |
| GET | `/api/brand` | `authenticateToken` | — | — | `brand.controller.get` |
| PATCH | `/api/brand` | `authenticateToken` | `settings:branding` | service-side per-field (`canUseLogo`, `canUseCustomEmail`) | `brand.controller.update` |
| DELETE | `/api/brand` | `authenticateToken` | `settings:branding` | — | `brand.controller.reset` |
| POST | `/api/brand/domain` | `authenticateToken` | `settings:branding` | enterprise only (`canUseCustomDomain`) | `brand.controller.setDomain` |
| POST | `/api/brand/domain/verify` | `authenticateToken` | `settings:branding` | — (token must already exist) | `brand.controller.verifyDomain` |
| DELETE | `/api/brand/domain` | `authenticateToken` | `settings:branding` | — | `brand.controller.removeDomain` |

Notes:
- `getPublic` is registered **before** `router.use(authenticateToken)` at
  `brand.routes.ts:16` so an unauthenticated request can resolve a custom
  domain to its public branding (display name + logo + favicon + colors)
  for the login page.
- `getPublic` returns `null` data when the domain doesn't match any
  verified record (i.e., it does not 404). The service filter requires
  `customDomainVerifiedAt IS NOT NULL` — unverified domains are never
  served.
- Tier gating is **service-side only** in `updateBrandSettings`: PRO+ for
  `logoUrl`/`faviconUrl`/`emailFromName`/`emailFromAddress`, ENTERPRISE
  for `customDomain`. Plan rank table at `brand.service.ts:44-50` —
  noteworthy that `pro` and `business` are both rank 2 and treated
  identically, while the rest of the codebase's `PlanSlug` is
  `free|starter|business|enterprise` (no `pro`). See open questions.

### `/api/brands` (multi-brand catalog)

| Method | Path | Auth | Permission | Handler |
|---|---|---|---|---|
| GET | `/api/brands?includeArchived=` | `authenticateToken` | — | `brands.controller.list` |
| GET | `/api/brands/stats` | `authenticateToken` | — | `brands.controller.stats` |
| GET | `/api/brands/:id` | `authenticateToken` | — | `brands.controller.detail` |
| POST | `/api/brands` | `authenticateToken` | `settings:branding` | `brands.controller.create` |
| PATCH | `/api/brands/:id` | `authenticateToken` | `settings:branding` | `brands.controller.update` |
| POST | `/api/brands/:id/default` | `authenticateToken` | `settings:branding` | `brands.controller.setDefault` |
| DELETE | `/api/brands/:id` | `authenticateToken` | `settings:branding` | `brands.controller.remove` |

Notes:
- Route order in `brands.routes.ts`: `GET /` → `GET /stats` → `GET /:id`.
  Express matches `/stats` before `/:id` because both are GET and `/stats`
  is registered first, so `/api/brands/stats` is **not** captured by
  `/:id`. (Verified by inspection of `brands.routes.ts:9-11`.)
- No feature gate is mounted on this router despite `multi_brand` existing
  as a `FEATURE_CATALOG` entry (`feature-flags.service.ts:170`). See open
  questions.

---

## 3. Data model

### `BrandSettings` — `brand_settings` table

`prisma/schema.prisma:1687-1731`. Migration:
`prisma/migrations/20260502100000_add_brand_settings/migration.sql`.

Columns: `id` (uuid PK), `companyId` (unique), `displayName`, `logoUrl`,
`faviconUrl`, `primaryColor`, `accentColor`, `emailFromName`,
`emailFromAddress`, `customDomain` (unique), `customDomainVerifiedAt`,
`customDomainVerificationToken`, `createdAt`, `updatedAt`.

Indexes: unique on `companyId`, unique on `customDomain`, plus index on
`companyId` and on `customDomain` (the unique index already covers each
of these on the read side; the explicit `@@index` lines are redundant
but harmless).

### `Brand` — `brands` table

`prisma/schema.prisma:1897-1916`. Migration:
`prisma/migrations/20260505100000_add_brands/migration.sql` — the same
file also adds `brandId TEXT` columns + composite indexes to
`customers`, `deals`, and `activities`.

Columns: `id` (uuid PK), `companyId`, `name`, `slug`, `logoUrl`,
`primaryColor`, `description`, `isDefault` (bool, default false),
`isArchived` (bool, default false), `createdAt`, `updatedAt`.

Indexes: composite unique on `(companyId, slug)`, plus indexes on
`companyId` and `(companyId, isArchived)`.

`brandId` is referenced by `Customer.brandId` (`schema.prisma:231`),
`Deal.brandId` (`:298`), and `Activity.brandId` (`:339`) but is **only a
soft tag** — there is no FK relation declared on either side, just a
nullable `String?` column with a matching index. Cross-tenant ownership
is enforced at the service layer via
`brands.service.assertBrandOwnedByCompany`, called from
`customer.service.ts:64,218`, `deal.service.ts:78`, and
`activity.service.ts:27`.

---

## 4. AuthN / AuthZ / tier gating

- **Auth.** Both routers mount `authenticateToken` (the public
  `getPublic` is the only exception, registered before the `use(auth)`
  call). `authenticateToken` chains into `enforceIpAllowlist` so brand
  endpoints respect the company-level IP allowlist for free.
- **AuthZ.** All write endpoints on both routers are wrapped with
  `requirePermission("settings:branding")`. `super_admin` bypasses
  permission checks (`requirePermission.ts` — RBAC service handles the
  bypass). `settings:branding` is defined in
  `src/constants/permissions.ts:35,307`. The label/description there
  reads: *"Manage brands, logos, and company profile."*
- **Tier gating.** Only `/api/brand` enforces tier rules, and only
  inside the service (`brand.service.ts:198-210, 296-301`). `/api/brands`
  has **no plan-tier check** — the `multi_brand` feature exists in the
  catalog but is not consulted by either the route or the service.

---

## 5. Audit logging

Audit calls go through `recordAudit` (`src/utils/audit.ts:47`), which is
fire-and-forget (errors are caught and logged, never propagated).

**`/api/brand` controller** (`brand.controller.ts`) records:
- `brand.updated` — entityType `brand_settings`, only `metadata.fields`
  (no before/after snapshot).
- `brand.reset` — entityType `brand_settings`, no entityId, no diff.
- `brand.custom_domain_set` — metadata.customDomain, no diff.
- `brand.custom_domain_verified` — only on success.
- `brand.custom_domain_removed` — no diff.

**`/api/brands` controller** (`brands.controller.ts`) records:
- `brand.created` — `after: data`, metadata `{ name, slug }`.
- `brand.updated` — `before` (loaded via `getBrand(...).catch(() => null)`)
  + `after`, metadata.fields.
- `brand.set_default` — `before` + `after`.
- `brand.archived` or `brand.deleted` (chosen by `data.archived`) — `before`.

The two controllers reuse the `brand.updated` action string for
**different** `entityType`s (`brand_settings` vs `brand`). Audit
consumers will need to disambiguate by `entityType`.

---

## 6. Validation

### `/api/brand` PATCH body (`brand.controller.ts:44-52`)

Zod schema:
- `displayName` — string, max 100, nullable, optional
- `logoUrl` / `faviconUrl` — `z.string().url()`, nullable, optional
- `primaryColor` / `accentColor` — string, nullable, optional
  (hex `#RRGGBB` validation re-checked in service)
- `emailFromName` — string, max 100, nullable, optional
- `emailFromAddress` — `z.string().email()`, nullable, optional

Service layer (`brand.service.ts:186-217`) re-runs URL/hex/email checks
and applies tier gates before issuing a parameterized
`UPDATE brand_settings` (or `INSERT` when no row exists).

### `/api/brand/domain` POST body (`brand.controller.ts:108-110`)

`{ customDomain: string (3..253) }`. Service then enforces the strict
hostname regex at `brand.service.ts:93-99` and rejects duplicates across
tenants (`brand.service.ts:306-314`).

### `/api/brands` POST/PATCH body (`brands.controller.ts:49-79`)

Create:
- `name` — 1..100
- `slug` — 3..62 (service additionally enforces
  `^[a-z0-9][a-z0-9-]{1,60}[a-z0-9]$`)
- `logoUrl` — `z.string().url()`, nullable, optional
- `primaryColor` — string, nullable, optional (hex re-checked in service)
- `description` — string, max 500, nullable, optional

Update is `createSchema.partial().extend({ isArchived: z.boolean().optional() })`.

### `/api/brands` GET list

`?includeArchived=true` (string) toggles inclusion of archived rows;
anything else (including `1`) is treated as false
(`brands.controller.ts:25`).

### `/api/brands/stats`

No query parameters. Returns one row per distinct `customers.brandId`
(including the `null` "unbranded" bucket) with `customerCount`,
`dealCount`, `activityCount`. SQL is at `brands.service.ts:330-350`.

---

## 7. Behavioural details worth knowing

- **First brand becomes default.** `createBrand` counts active brands
  for the company; if zero, the new brand is inserted with
  `isDefault = true` (`brands.service.ts:136-156`).
- **Default promotion on archive/delete.** Archiving the current default
  via PATCH `isArchived: true` clears its default flag and promotes the
  oldest remaining active brand (`brands.service.ts:207-227, 239-252`).
  `setDefaultBrand` runs the demote+promote in a single
  `prisma.$transaction` (`:266-275`).
- **Soft-delete on in-use brands.** `deleteBrand` checks
  `customers + deals + activities` row counts referencing the brand. If
  any rows exist, the brand is archived rather than hard-deleted; the
  controller surfaces this distinction in the audit action
  (`brand.archived` vs `brand.deleted`) and the response body
  (`{ deleted, archived }`).
- **Custom domain verification is real DNS.** `verifyCustomDomain`
  dynamically imports `dns` and calls `resolveTxt` on
  `_zyrix-challenge.{customDomain}` (`brand.service.ts:373-380`). On any
  DNS error or TXT mismatch it returns `{ verified: false, reason }`
  instead of throwing.
- **`getPublicBrandByDomain` lowercases + trims** the `?domain=` value
  before lookup (`brand.service.ts:155`). The inserted `customDomain`
  is normalized the same way at `setCustomDomain`
  (`brand.service.ts:302`).
- **Stats query uses a LEFT JOIN through customers.** `getBrandStats`
  groups by `customers.brandId`; deals/activities are joined via
  `customerId`/`dealId`. Brands that have **no customers** (e.g. a brand
  that only owns deals tagged directly) will not appear in the result
  set. Unbranded rows aggregate under `brandId = null`. (Also see open
  questions.)
- **Persistence layer.** Both services use `prisma.$queryRawUnsafe` /
  `$executeRawUnsafe` rather than the Prisma model client, even though
  the `Brand` and `BrandSettings` models are declared in
  `schema.prisma`. Parameters are bound positionally (`$1`, `$2`, …) so
  the queries are parameterized despite the `Unsafe` suffix.

---

## 8. Inbound dependencies (who calls these endpoints?)

Backend code reads from / writes to brand storage from a few places
besides the routes themselves:

- `customer.service.ts` (`:64`, `:218`), `deal.service.ts` (`:78`), and
  `activity.service.ts` (`:27`) call
  `assertBrandOwnedByCompany(companyId, dto.brandId)` before persisting
  a `brandId` on a write. This is the only cross-tenant safeguard for
  the soft tag.
- No other service appears to read `brand_settings` directly. Email
  send-time pickup of `emailFromName/emailFromAddress` is mentioned in
  comments (`brand.service.ts:208-209`) but I did not confirm a
  consumer exists yet — log open question.

Frontend consumers were not in scope.

---

## 9. Tests

`scripts/` contains a single regression script
(`regression-admin-company-details.ts`) that does not exercise either
brand surface. There are no unit or integration tests under `src/` or a
top-level `test/` / `tests/` / `__tests__/` directory for brand routes,
controllers, or services.

---

## 10. Open questions

> Per the sprint instructions I did not "fix" anything I noticed; each
> item below is logged for the planning step.

1. **`multi_brand` feature flag is unused.** `multi_brand` is in
   `FEATURE_CATALOG` (`feature-flags.service.ts:170`) with `defaultByPlan
   = ALL_ON`, but `brands.routes.ts` does not mount
   `gateFeature("multi_brand")`. Other premium routes in the same code
   pattern do (`ai_workflows`, `ai_cfo`, `loyalty`, `tax_invoices`,
   etc.). Was this intentional (because the default is ALL_ON anyway)
   or an omission that breaks per-merchant disable from the admin UI?
2. **Plan rank `pro` is undefined elsewhere.** `brand.service.ts:44-50`
   uses a custom plan ladder `free|starter|pro|business|enterprise` and
   ranks `pro` and `business` as equal (rank 2). The rest of the
   codebase's `PlanSlug` is `free|starter|business|enterprise`
   (`feature-flags.service.ts:33`). If `Company.plan` ever holds `"pro"`
   it would be honored by `/api/brand` but ignored everywhere else.
   Worth confirming the canonical set.
3. **Permission label says "brands"; settings module owns it.** The
   `settings:branding` permission both gates white-label settings
   (`/api/brand`) and multi-brand catalog (`/api/brands`). The label in
   `permissions.ts:316` reads "Manage brands, logos, and company
   profile" which conflates the two. Splitting into
   `settings:branding` + `brands:write` (or similar) would let merchants
   delegate one without the other.
4. **`getBrand(...).catch(() => null)` is a no-op catch.** In
   `brands.controller.ts:86,108,129`, `getBrand` is called with a
   trailing `.catch(() => null)` to load the `before` snapshot for
   audit. `getBrand` returns `null` rather than throwing on missing
   row, so the `catch` only swallows real DB errors — possibly hiding
   problems. Intentional belt-and-suspenders, or stale code?
5. **Audit reuses `brand.updated` for two entity types.** Both
   controllers emit `action: "brand.updated"` with different
   `entityType`s (`brand_settings` vs `brand`). Downstream audit
   consumers (admin audit log UI, exports) need to be aware they must
   disambiguate. Consider splitting into `brand_settings.updated` /
   `brand.updated`.
6. **`/api/brand` PATCH audit lacks before/after.** The white-label
   updater records only `metadata.fields = Object.keys(dto)`, no
   `before` / `after` snapshot. The multi-brand controller does include
   them. The recent commit history shows we've been moving toward
   before/after on mutations (e.g. `75b5542 feat(audit): before/after
   snapshots on campaign mutations`); the white-label settings
   controller hasn't caught up.
7. **`verifyCustomDomain` has no DNS timeout.** `dns.resolveTxt` is
   awaited without a timeout (`brand.service.ts:374-380`). A slow DNS
   resolver could block the request thread for the full system DNS
   timeout (often 30 s). Should we wrap it with a hard cap?
8. **`getBrandStats` only counts brands that own customers.** The query
   groups on `customers.brandId`, so a brand with deals/activities but
   no customers would not appear in the result. The endpoint name
   (`/stats`) implies "every brand" — verify this is the intended
   shape, or restructure to be `LEFT JOIN brands` so empty brands show
   `0/0/0`.
9. **`brand_settings` has redundant indexes.** `@@index([companyId])`
   and `@@index([customDomain])` duplicate the unique indexes that
   already exist on the same columns (`schema.prisma:1689,1719`).
   No correctness issue, just bloat.
10. **`brand_settings.emailFromName/Address` consumers unconfirmed.**
    The PR comment promises these flow into transactional email
    sending, but I did not find a consumer that reads the columns at
    send time. Worth a follow-up grep on the email/templates services
    before relying on it.
11. **Brand soft tag has no FK.** `Customer.brandId`, `Deal.brandId`,
    and `Activity.brandId` are nullable strings with no Prisma relation
    or DB-level FK to `brands.id`. Cross-tenant safety relies on every
    write going through `assertBrandOwnedByCompany`. If a future writer
    bypasses the service helper, orphan or cross-tenant references
    become possible. Add an FK + ON DELETE SET NULL?
12. **`as any` in brands.controller create/update.** Lines `60` and
    `85` cast `createSchema.parse(req.body) as any` before passing to
    the service. This loses the Zod-enforced type narrowing
    immediately. Probably to satisfy the optional `null | undefined`
    asymmetry between Zod and the `CreateBrandInput` interface — a
    follow-up could align the types instead.

---

## 11. Files inspected (for the next agent)

- `src/index.ts` (mount points L46, L50, L204, L208)
- `src/routes/brand.routes.ts`
- `src/routes/brands.routes.ts`
- `src/controllers/brand.controller.ts`
- `src/controllers/brands.controller.ts`
- `src/services/brand.service.ts`
- `src/services/brands.service.ts`
- `src/middleware/auth.ts`
- `src/middleware/requirePermission.ts`
- `src/middleware/feature-gate.ts`
- `src/middleware/errorHandler.ts`
- `src/services/feature-flags.service.ts` (catalog only)
- `src/constants/permissions.ts` (`settings:branding` entry)
- `src/utils/audit.ts`
- `prisma/schema.prisma` (BrandSettings @ 1675-1732, Brand @ 1885-1916,
  brandId tags @ 231/298/339)
- `prisma/migrations/20260502100000_add_brand_settings/migration.sql`
- `prisma/migrations/20260505100000_add_brands/migration.sql`
- `src/services/customer.service.ts`, `deal.service.ts`,
  `activity.service.ts` (callers of `assertBrandOwnedByCompany`)
