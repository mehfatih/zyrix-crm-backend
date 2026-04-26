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
13. **Production and local development share a single Postgres
    instance.** Surfaced incidentally during this audit (see 12.4) —
    the local `.env` `DATABASE_URL` resolves to the production Railway
    database, so there is no dev or staging environment. This means
    every recovery action, every migration deploy, and every `prisma
    migrate dev` invocation runs directly against live customer data.
    It also means this incident had no rehearsal environment —
    whatever Path C/B/C action we take in C-1.C will be the first time
    it runs in the only environment that exists. **Out of scope for
    sprint C-1.** Recorded here as the durable follow-up entry for a
    separate sprint that provisions a dev/staging Postgres instance,
    splits `DATABASE_URL` per environment, and updates the CI/local
    setup to point at it.

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

---

## 12. Root cause hypothesis for the 500s

> Added 2026-04-26 after the missing reproduction step (sections 5–6 of the
> sprint brief) was actually performed. The local development environment
> connects to the same database as production, so all "live DB" evidence
> below is taken against production.

### 12.1 Reproduction

Server boots cleanly via `npm run dev`. Without auth, all three endpoints
return a clean 401 — routes are mounted, auth fires. With a freshly
minted owner JWT (silently, via `scripts/mint-dev-token.ts`):

| Endpoint | HTTP | Postgres code | Underlying error |
|---|---|---|---|
| `GET /api/brand`        | 500 | `42P01` | `relation "brand_settings" does not exist` (`brand.service.ts:122` → `brand.controller.ts:33`) |
| `GET /api/brands`       | 500 | `42P01` | `relation "brands" does not exist` (`brands.service.ts:60` → `brands.controller.ts:26`) |
| `GET /api/brands/stats` | 500 | `42703` | `column c.brandId does not exist` (`brands.service.ts:330` → `brands.controller.ts:148`) |

All three are `PrismaClientKnownRequestError` from `$queryRawUnsafe`.
`42P01` = undefined_table, `42703` = undefined_column.

### 12.2 Failed migration analysis

`_prisma_migrations` row, 1-of-1 in non-terminal state on the live DB:

```
migration_name : 20260430100000_add_ai_agents
started_at     : 2026-04-21T15:38:45.863Z
finished_at    : null
rolled_back_at : null
logs           : Database error code: 42710
                 ERROR: constraint "ai_messages_threadId_fkey" for
                        relation "ai_messages" already exists
```

Railway deploy log excerpt (provided 2026-04-26):

> migrate found failed migrations in the target database, new migrations
> will not be applied.
>
> The `20260430100000_add_ai_agents` migration started at
> 2026-04-21 15:38:45.863542 UTC failed
>
> Error: P3009

The trigger is one non-idempotent statement in
`prisma/migrations/20260430100000_add_ai_agents/migration.sql`:

```sql
ALTER TABLE "ai_messages"
  ADD CONSTRAINT "ai_messages_threadId_fkey"
  FOREIGN KEY ("threadId") REFERENCES "ai_threads"("id") ON DELETE CASCADE;
```

Postgres has no `ADD CONSTRAINT IF NOT EXISTS` for foreign keys, so
re-running this against a database that already has the constraint
fails with `42710` (`duplicate_object`). Every other statement in the
file uses `IF NOT EXISTS` and is safe to replay. The migration
presumably succeeded on a first run (creating both tables, all three
indexes, and the FK), then was retried — at which point this single
ADD threw and the row was left half-finished. P3009 is Prisma's
"there's a non-terminal row in `_prisma_migrations`, refusing to
apply anything new" code.

### 12.3 Per-statement classification

Every statement in the failed migration is **ALREADY APPLIED** on the
live DB. Verified against `information_schema.columns`,
`pg_constraint`, and `pg_indexes` (probe (b) and (c) of the planning
brief).

| # | Statement (short) | Classification | Evidence |
|---|---|---|---|
| 1 | `CREATE TABLE IF NOT EXISTS "ai_threads" (… 9 cols)` | ALREADY APPLIED | `information_schema.tables` returns `ai_threads`. All 9 columns present with matching types, nullability, and defaults: `id text NOT NULL`, `companyId text NOT NULL`, `userId text NOT NULL`, `agentKind text NOT NULL`, `title text NULL`, `relatedActivityId text NULL`, `archived bool NOT NULL DEFAULT false`, `createdAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP`, `updatedAt timestamp NOT NULL`. `ai_threads_pkey` (PRIMARY KEY (id)) present. |
| 2 | `CREATE INDEX IF NOT EXISTS "ai_threads_companyId_userId_agentKind_idx" ON "ai_threads"(…)` | ALREADY APPLIED | `pg_indexes.indexdef` matches: `CREATE INDEX "ai_threads_companyId_userId_agentKind_idx" ON public.ai_threads USING btree ("companyId", "userId", "agentKind")`. |
| 3 | `CREATE INDEX IF NOT EXISTS "ai_threads_companyId_updatedAt_idx" ON "ai_threads"(…)` | ALREADY APPLIED | `pg_indexes.indexdef` matches: `CREATE INDEX "ai_threads_companyId_updatedAt_idx" ON public.ai_threads USING btree ("companyId", "updatedAt")`. |
| 4 | `CREATE TABLE IF NOT EXISTS "ai_messages" (… 8 cols)` | ALREADY APPLIED | `information_schema.tables` returns `ai_messages`. All 8 columns present with matching types/nullability/defaults: `id text NOT NULL`, `threadId text NOT NULL`, `role text NOT NULL`, `content text NOT NULL`, `toolCall jsonb NULL`, `promptTokens int NOT NULL DEFAULT 0`, `completionTokens int NOT NULL DEFAULT 0`, `createdAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP`. `ai_messages_pkey` (PRIMARY KEY (id)) present. |
| 5 | `CREATE INDEX IF NOT EXISTS "ai_messages_threadId_createdAt_idx" ON "ai_messages"(…)` | ALREADY APPLIED | `pg_indexes.indexdef` matches: `CREATE INDEX "ai_messages_threadId_createdAt_idx" ON public.ai_messages USING btree ("threadId", "createdAt")`. |
| 6 | `ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ai_threads"("id") ON DELETE CASCADE` | ALREADY APPLIED | `pg_constraint`: `ai_messages_threadId_fkey contype=f`, def: `FOREIGN KEY ("threadId") REFERENCES ai_threads(id) ON DELETE CASCADE` — exact match. **This is the single statement that re-throws 42710 on retry.** |

So **every effect of the migration is already realized in the schema**.
The migration was a one-liner away from succeeding the first time.

### 12.4 Production and local are in identical schema state

Same database, single source of truth — confirmed by exact-microsecond
match between the local `_prisma_migrations` `started_at` value and the
production deploy-log timestamp in the Railway excerpt. Brand-table
probe (item f) confirms both `brands` and `brand_settings` are absent:

```
public.brands         → absent
public.brand_settings → absent
```

Identical state on both surfaces because there is no dev/prod DB split.

### 12.5 Blocked migrations queue

Item (h) confirms 20 / 20 on-disk migrations dated after
`20260430100000_add_ai_agents` are absent from `_prisma_migrations`:

```
20260501100000_add_oauth_states
20260502100000_add_brand_settings           ← causes /api/brand 500
20260503100000_add_collaboration
20260504100000_add_scheduled_reports
20260505100000_add_brands                   ← causes /api/brands + /api/brands/stats 500
20260506100000_add_tax_invoices
20260507100000_add_enabled_features
20260508100000_add_user_profile_fields
20260509100000_add_session_events
20260510100000_add_rbac_roles
20260511100000_audit_logs_expand
20260512100000_onboarding_progress
20260513100000_ip_allowlist
20260514100000_retention_policies
20260515100000_compliance_tokens
20260516100000_scim_tokens
20260517100000_network_rules
20260518100000_document_links
20260519100000_bonus_b1_b10
20260520100000_docs_sprint
```

Other endpoints to spot-check after the recovery deploy: `/api/oauth`,
`/api/comments`, `/api/notifications`, `/api/analytics-reports`,
`/api/tax-invoices`, `/api/session-events`, `/api/feature-flags`,
`/api/audit-logs`, `/api/admin/ip-allowlist`, `/api/data-retention`,
`/api/compliance`, `/scim/v2`, `/api/admin/network-rules`,
`/api/documents`, `/api/bonus`, `/api/docs`.

### 12.6 Two orphan migrations also absent from `_prisma_migrations`

Item (g) returned 26 rows. Two on-disk migration folders dated
*before* `20260430` are also missing rows, despite their schema
effects being live (the rest of the codebase that depends on them
works):

- `20260420150924_add_admin_panel_schema` — almost certainly a stale
  rename leftover; it is shadowed by `20260420160000_add_admin_panel_schema`
  with the same final name, which did apply at 2026-04-20T16:36:19.937Z.
- `20260422100000_password_reset_tokens` — sits in the timeline
  between `20260422090000_add_webhooks` (applied 2026-04-21T10:02:10.966Z)
  and `20260423100000_add_webhook_retry` (applied 2026-04-21T11:07:50.291Z).
  No matching shadow folder. Looks like a manual `prisma db execute`
  or out-of-band SQL that bypassed the migration table.

**This matters for recovery.** After resolving the failed `20260430`
row, `prisma migrate deploy` will see 22 migrations on disk that aren't
in `_prisma_migrations` (20 blocked + 2 orphans). It applies them in
chronological order — so the 2 orphans go FIRST, before any of the 20
blocked. If either orphan's SQL is non-idempotent against the current
live schema, the deploy will fail again at one of the orphans and the
20 blocked never get applied.

Recommended pre-recovery action: read both orphan migration files,
classify their statements the same way 12.3 does, and either confirm
they're already-applied + idempotent, or `prisma migrate resolve
--applied` them too before running `prisma migrate deploy`. **This was
not in scope for the C1 audit and has not been done.**

### 12.7 Why this stayed invisible in production

- `package.json` `start`:
  ```js
  spawnSync('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'inherit', shell: true });
  require('./dist/index.js');
  ```
  The `spawnSync` exit code is **never checked**. P3009 from migrate
  deploy aborts the migration queue but does not abort the boot.
- `src/middleware/errorHandler.ts:60` only `console.error`s when
  `isDevelopment` is true. In prod the response body is also redacted to
  `{"code":"INTERNAL_ERROR","message":"An unexpected error occurred"}`.
  Result: production runtime logs contain no stack trace for these
  500s, only a morgan combined access-log line with status 500. The
  P3009 evidence is in the **deploy** logs, not runtime.
- Production has been in this broken-schema state since
  **2026-04-21 15:38 UTC — five days at the time of writing.** Real
  traffic has continued to hit the API throughout (Railway access logs
  show clients polling `/api/chat/unread`).

### 12.8 Fix scope and recovery decision

**Fix scope: DB migration recovery only. No application code changes
are required to clear the 500s** on `/api/brand`, `/api/brands`, and
`/api/brands/stats`. The handlers and services are correct; once the
queue drains and the brand tables + `brandId` columns exist, all three
endpoints will return 200 against the same build that ships HEAD today.

| Path | What it does | Verdict on this incident |
|---|---|---|
| **A** — `prisma migrate resolve --rolled-back 20260430…`, then re-run the SQL as-is | Re-executes the ALTER, which re-throws 42710 immediately because the FK already exists (12.3 row 6) | **Not viable.** Wastes a deploy cycle, queue still blocked. |
| **B** — `prisma migrate resolve --rolled-back 20260430…`, edit the SQL to be idempotent (`DO $$ … EXCEPTION WHEN duplicate_object …`), then re-run | Mutates an immutable migration file and runs DDL on a live DB with users on it | Works, but mutates history and runs unnecessary DDL given the schema is already complete. |
| **C** — `prisma migrate resolve --applied 20260430100000_add_ai_agents` | Tells Prisma the migration is done without running any SQL | **Recommended.** Single-row `_prisma_migrations` update, no DDL, no schema mutation. Safe because 12.3 confirms every effect of the migration is already realized. |

**Evidence-based justification for C:** The classification table in
12.3 shows every one of the 6 statements is ALREADY APPLIED and
idempotency-safe to skip. Running the SQL again (paths A or B) does
not change the schema in any meaningful way — it would, at best,
re-confirm what's already there. Path C records "this migration is
done" without doing anything, which is exactly correct.

### 12.9 Per-path risk under "live users present"

Production has live traffic (chat polling visible). All three paths
ultimately reach the same end state: `_prisma_migrations` says
`20260430` is done, then `prisma migrate deploy` drains the 22
remaining migrations (20 blocked + 2 orphans from 12.6).

| Risk | Path A | Path B | Path C |
|---|---|---|---|
| Recovery itself **mutates production schema** | No — fails before any DDL | **Yes** — re-runs the FK ALTER (idempotent under B's edit, but DDL still executes) | No — pure metadata write to one row of `_prisma_migrations` |
| Recovery itself takes a **table lock** that could affect live queries | No — fails fast | Possible — `ALTER TABLE … ADD CONSTRAINT` takes ACCESS EXCLUSIVE on `ai_messages` briefly (table is small / low-traffic, so impact is sub-second, but non-zero) | No |
| Mutates an **immutable migration file** in the repo | No | **Yes** — edits `20260430.../migration.sql`, which is a Prisma anti-pattern (other envs that successfully applied the migration would diverge) | No |
| Resolves the failed row | Yes (as rolled-back) | Yes (as rolled-back, then re-applied) | Yes (as applied) |
| Unblocks `prisma migrate deploy` | Yes — but deploy then **immediately re-fails** at the same 42710 | Yes — deploy proceeds | Yes — deploy proceeds |
| Number of deploy cycles required | 2+ (the first one re-fails at A's rerun) | 1 | 1 |
| Risk of the **22 follow-on migrations** affecting live traffic | Same for all three paths once we get there: each migration's DDL runs against live tables. Most are pure `CREATE TABLE IF NOT EXISTS` (low risk). The two orphans from 12.6 are unaudited and could re-block the queue. The 20 blocked migrations should be grep'd for bare `ALTER TABLE` / `ADD CONSTRAINT` / `CREATE INDEX` (without `IF NOT EXISTS`) before deploy. ALTER on heavily-written tables (e.g. `customers`, `deals`) needs special care. |
| Reversibility if it goes wrong | Easy — nothing happened | Hard — DDL has run, repo file edited | Easy — `prisma migrate resolve --rolled-back 20260430…` reverts the metadata |

**Summary: Path C is strictly the lowest-risk option for the failed-row
recovery itself.** All three paths share the same downstream risk from
running the 22 follow-on migrations against live traffic; that risk is
audit-then-execute, independent of recovery path choice.

### 12.10 Recommended sequence (planning only — not executed per sprint brief)

1. Read `prisma/migrations/20260420150924_add_admin_panel_schema/migration.sql`
   and `prisma/migrations/20260422100000_password_reset_tokens/migration.sql`.
   Classify each statement the same way 12.3 does.
2. Grep all 20 blocked migrations for non-idempotent DDL (bare
   `ADD CONSTRAINT`, `CREATE INDEX` without `IF NOT EXISTS`,
   `ADD COLUMN` on big tables, etc.). Patch any that look like
   they could fail under live traffic.
3. Take a logical snapshot of the prod DB (Railway PITR or
   `pg_dump` of the schema + critical tables).
4. Maintenance window or low-traffic hour:
   1. `prisma migrate resolve --applied 20260430100000_add_ai_agents`
      (and the same for the 2 orphans if 12.6 confirms ALREADY APPLIED;
      otherwise, `--rolled-back` and patch).
   2. `prisma migrate deploy`.
   3. Smoke-test `/api/brand`, `/api/brands`, `/api/brands/stats`,
      plus the spot-check endpoints from 12.5.
5. Independently of recovery, follow up on the two code changes
   from the original draft of this section:
   - Make `package.json` `start` fail-closed on `prisma migrate deploy`
     non-zero exit.
   - Drop the `isDevelopment` gate around `console.error` in
     `errorHandler.ts:60` so the next 500 leaves a stack in Railway
     runtime logs.

---

## 13. Orphan migrations classification (C-1.A)

> Added 2026-04-26. Section 12.6 surfaced two on-disk migration folders
> dated *before* `20260430` that are missing rows from `_prisma_migrations`.
> This section classifies them so the sprint C-1.B pre-flight audit and
> the C-1.C recovery have everything they need. Pure SELECT probes only
> (no DDL, no transactions); evidence drawn from `information_schema`,
> `pg_constraint`, and `pg_indexes` against the same DB the rest of the
> report queries.

### 13.1 SQL-content comparison: 20260420150924 vs 20260420160000

The two `add_admin_panel_schema` folders share a final name but have
distinct timestamp prefixes — they coexist on disk; only the later one
has a row in `_prisma_migrations`.

| | 20260420150924 (orphan) | 20260420160000 (applied) |
|---|---|---|
| Lines | 281 | 254 |
| SHA-256 (first 12 chars) | `2d32db0c8b52…` | `7f27e24d0ef5…` |
| Byte-identical? | **No** — different files |
| `_prisma_migrations` row | absent | applied @ 2026-04-20T16:36:19.937Z |
| Style | Prisma-`migrate dev` default output (bare DDL) | Hand-rewritten safer twin |
| `CREATE TABLE` | bare (no `IF NOT EXISTS`) | guarded (`CREATE TABLE IF NOT EXISTS`) |
| `CREATE INDEX` | bare | guarded |
| `ALTER TABLE … ADD COLUMN` | bare | guarded (`ADD COLUMN IF NOT EXISTS`) |
| `ALTER TABLE … ADD CONSTRAINT` (FKs) | bare — would `42710` on rerun | **also bare** — would `42710` on rerun (latent bug, but moot since 160000 already applied) |
| Target schema | identical: 7 tables, 12 added columns, 34 indexes, 10 FKs | identical |

The two files create the same schema; the difference is purely how they
handle re-runs. The presence of two folders is a classic symptom of
`prisma migrate dev` being invoked twice on the same change — once
generating 150924, then again (after a manual rename / reset) generating
160000 — without removing the first folder from disk.

### 13.2 Per-statement classification: `20260420150924_add_admin_panel_schema`

Statements grouped by type for readability. **All grouped statements
are ALREADY APPLIED** on the live DB; verified counts match exactly
the migration's intent.

| Statement group | Count | Classification | Evidence |
|---|---|---|---|
| `ALTER TABLE "companies" ADD COLUMN …` | 9 | ALREADY APPLIED | `information_schema.columns` returns all 9 added columns on `companies`: `billingEmail text NULL`, `country text NULL`, `deletedAt timestamp NULL`, `industry text NULL`, `size text NULL`, `status text NOT NULL DEFAULT 'active'`, `suspendReason text NULL`, `suspendedAt timestamp NULL`, `trialEndsAt timestamp NULL`. Types/nullability/defaults all match. |
| `ALTER TABLE "users" ADD COLUMN …` | 3 | ALREADY APPLIED | `information_schema.columns` returns `disabledAt timestamp NULL`, `disabledReason text NULL`, `status text NOT NULL DEFAULT 'active'`. All match. |
| `CREATE TABLE …` | 7 | ALREADY APPLIED | All 7 tables present in `information_schema.tables`: `plans`, `plan_overrides`, `subscriptions`, `payments`, `audit_logs`, `announcements`, `support_tickets`. |
| `CREATE INDEX …` (incl. PK + UNIQUE) | 34 | ALREADY APPLIED | All 34 indexes present in `pg_indexes` with names matching the migration. Includes `plans_pkey`, `plans_slug_key`, `plan_overrides_companyId_featureSlug_key`, the new `companies_status_idx` / `companies_plan_idx` / `users_role_idx` / `users_status_idx`, and per-table operational indexes. |
| `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY …` | 10 | ALREADY APPLIED | All 10 FKs present in `pg_constraint` with `pg_get_constraintdef` matching: `plan_overrides_companyId_fkey`, `subscriptions_companyId_fkey`, `subscriptions_planId_fkey`, `payments_companyId_fkey`, `payments_subscriptionId_fkey`, `audit_logs_userId_fkey`, `audit_logs_companyId_fkey`, `support_tickets_companyId_fkey`, `support_tickets_createdById_fkey`, `support_tickets_assignedToId_fkey`. ON DELETE / ON UPDATE clauses all match. **These would each re-throw 42710 if 150924 were ever re-run.** |

Net: 63 statements, 63 ALREADY APPLIED, 0 NOT APPLIED, 0 PARTIAL.

### 13.3 Per-statement classification: `20260422100000_password_reset_tokens`

| # | Statement | Classification | Evidence |
|---|---|---|---|
| 1 | `CREATE TABLE IF NOT EXISTS "password_reset_tokens" (… 8 cols)` | ALREADY APPLIED | Table present. All 8 columns present with matching types/nullability/defaults: `id text NOT NULL`, `userId text NOT NULL`, `tokenHash text NOT NULL`, `expiresAt timestamp NOT NULL`, `usedAt timestamp NULL`, `ipAddress text NULL`, `userAgent text NULL`, `createdAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP`. `password_reset_tokens_pkey` (PRIMARY KEY (id)) present. |
| 2 | `CREATE UNIQUE INDEX IF NOT EXISTS "password_reset_tokens_tokenHash_key" ON …("tokenHash")` | ALREADY APPLIED | `pg_indexes.indexdef` matches: `CREATE UNIQUE INDEX "password_reset_tokens_tokenHash_key" ON public.password_reset_tokens USING btree ("tokenHash")`. |
| 3 | `CREATE INDEX IF NOT EXISTS "password_reset_tokens_userId_expiresAt_idx" ON …("userId","expiresAt")` | ALREADY APPLIED | `pg_indexes.indexdef` matches. |
| 4 | `CREATE INDEX IF NOT EXISTS "password_reset_tokens_expiresAt_idx" ON …("expiresAt")` | ALREADY APPLIED | `pg_indexes.indexdef` matches. |
| 5 | `DO $$ BEGIN ALTER TABLE … ADD CONSTRAINT "password_reset_tokens_userId_fkey" FOREIGN KEY …("userId") REFERENCES "users"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;` | ALREADY APPLIED | `pg_constraint`: `password_reset_tokens_userId_fkey contype=f`, def: `FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE` — exact match. **Wrapped in `DO $$ … EXCEPTION WHEN duplicate_object` — fully idempotent on rerun.** |

Net: 5 statements, 5 ALREADY APPLIED, 0 NOT APPLIED, 0 PARTIAL.

### 13.4 Resolve recommendation per orphan

| Migration | Recommendation | Justification |
|---|---|---|
| `20260420150924_add_admin_panel_schema` | **`prisma migrate resolve --applied`** | Schema effects 100% realized via the shadow 160000 migration. The file itself is non-idempotent — every one of its 9 ADD COLUMN statements would 42701 (`duplicate_column`) and every one of its 10 ADD CONSTRAINT statements would 42710 (`duplicate_object`) if rerun. We never want it to actually execute. `--applied` records "done" without running it. |
| `20260422100000_password_reset_tokens` | **`prisma migrate resolve --applied`** | Schema effects 100% realized. The file IS fully idempotent (CREATE … IF NOT EXISTS + DO/EXCEPTION wrapper on the FK), so a rerun would no-op cleanly — but there's no value in doing the work twice. `--applied` is the cleaner outcome. |

Neither orphan needs `--rolled-back` (which would queue them for the
next deploy) and neither needs SQL patching.

### 13.5 Risk assessment

Both `--applied` resolutions are **single-row metadata writes to
`_prisma_migrations`** with no DDL and no application-table touches.
Risk profile is identical to the C-1.B/C resolution of `20260430`:

| Risk | 20260420150924 | 20260422100000 |
|---|---|---|
| Mutates production schema | No | No |
| Takes any table lock | No | No |
| Affects live read/write traffic | No | No |
| Reversible via `prisma migrate resolve --rolled-back` | Yes | Yes |
| Failure mode if **skipped** (deploy run without resolving first) | **High** — `prisma migrate deploy` halts at the first bare `ADD COLUMN "billingEmail"` with `42701`, re-blocking the queue at 150924 instead of 20260430. The 20 brand/etc. migrations remain unapplied. | Low — file is idempotent; deploy would no-op every statement and continue cleanly. Still cleaner to resolve. |

**Critical sequencing note for C-1.C:** the resolve order matters
because `prisma migrate deploy` walks pending migrations
chronologically. The three resolves should be done **before** any
`migrate deploy` is attempted:

1. `prisma migrate resolve --applied 20260420150924_add_admin_panel_schema`
2. `prisma migrate resolve --applied 20260422100000_password_reset_tokens`
3. `prisma migrate resolve --applied 20260430100000_add_ai_agents`
4. *(only then)* `prisma migrate deploy` to drain the 20 blocked migrations

Any other order risks one of the bare-DDL orphans aborting the deploy
mid-queue.

### 13.6 Remaining unknown for C-1.B

This section does **not** audit the 20 blocked migrations (sprint
C-1.B's job). Those still need to be grep'd for non-idempotent DDL —
bare `ADD CONSTRAINT`, `CREATE INDEX` without `IF NOT EXISTS`,
`ADD COLUMN` on heavily-written tables (e.g. `customers`, `deals`,
`activities`) — before they execute against live traffic.
