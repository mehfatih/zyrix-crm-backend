// ============================================================================
// BRANDS SERVICE — multi-brand management
// ----------------------------------------------------------------------------
// A merchant (Company) can manage multiple brands under one Zyrix account.
// Each Customer/Deal/Activity optionally carries brandId so data can be
// filtered per-brand while sharing infrastructure (users, workflows, etc.).
//
// Business rule: each company has exactly one 'default' brand, auto-set
// when a merchant creates their first brand. When the default is deleted
// or archived, the service promotes the oldest remaining active brand.
// ============================================================================

import { prisma } from "../config/database";
import { badRequest, notFound } from "../middleware/errorHandler";

export interface BrandRow {
  id: string;
  companyId: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  primaryColor: string | null;
  description: string | null;
  isDefault: boolean;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

// ──────────────────────────────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────────────────────────────

function assertValidSlug(slug: string) {
  if (!/^[a-z0-9][a-z0-9-]{1,60}[a-z0-9]$/.test(slug)) {
    throw badRequest(
      "slug must be 3-62 lowercase alphanumeric chars with optional internal hyphens"
    );
  }
}

function assertValidHexColor(value: string | null | undefined) {
  if (!value) return;
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw badRequest("primaryColor must be a 6-char hex color like #FF6B9D");
  }
}

// ──────────────────────────────────────────────────────────────────────
// READ
// ──────────────────────────────────────────────────────────────────────

export async function listBrands(
  companyId: string,
  opts: { includeArchived?: boolean } = {}
): Promise<BrandRow[]> {
  const where = opts.includeArchived
    ? `"companyId" = $1`
    : `"companyId" = $1 AND "isArchived" = false`;
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id, "companyId", name, slug, "logoUrl", "primaryColor", description,
            "isDefault", "isArchived", "createdAt", "updatedAt"
     FROM brands WHERE ${where}
     ORDER BY "isDefault" DESC, "createdAt" ASC`,
    companyId
  )) as BrandRow[];
  return rows;
}

export async function getBrand(
  companyId: string,
  id: string
): Promise<BrandRow | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id, "companyId", name, slug, "logoUrl", "primaryColor", description,
            "isDefault", "isArchived", "createdAt", "updatedAt"
     FROM brands WHERE id = $1 AND "companyId" = $2 LIMIT 1`,
    id,
    companyId
  )) as BrandRow[];
  return rows[0] ?? null;
}

/**
 * Validate that a brandId belongs to the company. Used by customer/deal/
 * activity services before writing brandId — prevents cross-tenant leaks.
 */
export async function assertBrandOwnedByCompany(
  companyId: string,
  brandId: string | null | undefined
): Promise<void> {
  if (!brandId) return;
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id FROM brands WHERE id = $1 AND "companyId" = $2 AND "isArchived" = false LIMIT 1`,
    brandId,
    companyId
  )) as { id: string }[];
  if (rows.length === 0) {
    throw badRequest("Invalid brandId or brand is archived");
  }
}

// ──────────────────────────────────────────────────────────────────────
// CREATE
// ──────────────────────────────────────────────────────────────────────

export interface CreateBrandInput {
  name: string;
  slug: string;
  logoUrl?: string | null;
  primaryColor?: string | null;
  description?: string | null;
}

export async function createBrand(
  companyId: string,
  input: CreateBrandInput
): Promise<BrandRow> {
  if (!input.name.trim() || input.name.length > 100) {
    throw badRequest("Brand name must be 1-100 chars");
  }
  assertValidSlug(input.slug);
  assertValidHexColor(input.primaryColor);

  // Uniqueness check
  const existing = (await prisma.$queryRawUnsafe(
    `SELECT id FROM brands WHERE "companyId" = $1 AND slug = $2 LIMIT 1`,
    companyId,
    input.slug
  )) as { id: string }[];
  if (existing.length > 0) {
    throw badRequest(`A brand with slug '${input.slug}' already exists`);
  }

  // First brand becomes default automatically
  const countRows = (await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM brands WHERE "companyId" = $1 AND "isArchived" = false`,
    companyId
  )) as { n: number }[];
  const isDefault = (countRows[0]?.n ?? 0) === 0;

  const created = (await prisma.$queryRawUnsafe(
    `INSERT INTO brands
       (id, "companyId", name, slug, "logoUrl", "primaryColor", description,
        "isDefault", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
     RETURNING id, "companyId", name, slug, "logoUrl", "primaryColor", description,
               "isDefault", "isArchived", "createdAt", "updatedAt"`,
    companyId,
    input.name.trim(),
    input.slug,
    input.logoUrl ?? null,
    input.primaryColor ?? null,
    input.description ?? null,
    isDefault
  )) as BrandRow[];
  return created[0];
}

// ──────────────────────────────────────────────────────────────────────
// UPDATE
// ──────────────────────────────────────────────────────────────────────

export async function updateBrand(
  companyId: string,
  id: string,
  patch: Partial<CreateBrandInput> & { isArchived?: boolean }
): Promise<BrandRow> {
  const existing = await getBrand(companyId, id);
  if (!existing) throw notFound("Brand");

  if (patch.name !== undefined) {
    if (!patch.name.trim() || patch.name.length > 100) {
      throw badRequest("Brand name must be 1-100 chars");
    }
  }
  if (patch.slug !== undefined) {
    assertValidSlug(patch.slug);
    if (patch.slug !== existing.slug) {
      const clash = (await prisma.$queryRawUnsafe(
        `SELECT id FROM brands WHERE "companyId" = $1 AND slug = $2 AND id != $3 LIMIT 1`,
        companyId,
        patch.slug,
        id
      )) as { id: string }[];
      if (clash.length > 0) {
        throw badRequest(`A brand with slug '${patch.slug}' already exists`);
      }
    }
  }
  if (patch.primaryColor !== undefined) {
    assertValidHexColor(patch.primaryColor);
  }

  const updates: string[] = [];
  const values: any[] = [];
  let i = 1;
  const set = (col: string, val: any) => {
    updates.push(`"${col}" = $${i++}`);
    values.push(val);
  };
  if (patch.name !== undefined) set("name", patch.name.trim());
  if (patch.slug !== undefined) set("slug", patch.slug);
  if (patch.logoUrl !== undefined) set("logoUrl", patch.logoUrl);
  if (patch.primaryColor !== undefined) set("primaryColor", patch.primaryColor);
  if (patch.description !== undefined) set("description", patch.description);
  if (patch.isArchived !== undefined) {
    set("isArchived", patch.isArchived);
    // If archiving the default brand, clear the default flag — a promotion
    // follows afterward
    if (patch.isArchived && existing.isDefault) {
      updates.push(`"isDefault" = false`);
    }
  }

  if (updates.length === 0) return existing;
  updates.push(`"updatedAt" = NOW()`);
  values.push(id, companyId);
  await prisma.$executeRawUnsafe(
    `UPDATE brands SET ${updates.join(", ")} WHERE id = $${i} AND "companyId" = $${i + 1}`,
    ...values
  );

  // If we just archived the default brand, promote the oldest active one
  if (patch.isArchived && existing.isDefault) {
    await promoteOldestAsDefault(companyId);
  }

  const refreshed = await getBrand(companyId, id);
  if (!refreshed) throw notFound("Brand");
  return refreshed;
}

/**
 * Pick a new default when the previous one was archived/deleted. Oldest
 * active brand wins. If there are no active brands, nothing happens —
 * company has no default until they create another brand.
 */
async function promoteOldestAsDefault(companyId: string): Promise<void> {
  const candidates = (await prisma.$queryRawUnsafe(
    `SELECT id FROM brands
     WHERE "companyId" = $1 AND "isArchived" = false
     ORDER BY "createdAt" ASC LIMIT 1`,
    companyId
  )) as { id: string }[];
  if (candidates.length === 0) return;
  await prisma.$executeRawUnsafe(
    `UPDATE brands SET "isDefault" = true, "updatedAt" = NOW()
     WHERE id = $1`,
    candidates[0].id
  );
}

/**
 * Set a brand as the new default. Clears default flag from all others
 * atomically.
 */
export async function setDefaultBrand(
  companyId: string,
  id: string
): Promise<BrandRow> {
  const target = await getBrand(companyId, id);
  if (!target) throw notFound("Brand");
  if (target.isArchived) throw badRequest("Can't make an archived brand default");

  await prisma.$transaction([
    prisma.$executeRawUnsafe(
      `UPDATE brands SET "isDefault" = false WHERE "companyId" = $1 AND "isDefault" = true`,
      companyId
    ),
    prisma.$executeRawUnsafe(
      `UPDATE brands SET "isDefault" = true, "updatedAt" = NOW() WHERE id = $1`,
      id
    ),
  ]);

  const refreshed = await getBrand(companyId, id);
  if (!refreshed) throw notFound("Brand");
  return refreshed;
}

// ──────────────────────────────────────────────────────────────────────
// DELETE (hard — only if unused; otherwise archive)
// ──────────────────────────────────────────────────────────────────────

export async function deleteBrand(
  companyId: string,
  id: string
): Promise<{ deleted: boolean; archived?: boolean }> {
  const existing = await getBrand(companyId, id);
  if (!existing) throw notFound("Brand");

  // Check if any entities are tagged with this brand
  const inUse = (await prisma.$queryRawUnsafe(
    `SELECT
       (SELECT COUNT(*)::int FROM customers WHERE "companyId" = $1 AND "brandId" = $2) +
       (SELECT COUNT(*)::int FROM deals WHERE "companyId" = $1 AND "brandId" = $2) +
       (SELECT COUNT(*)::int FROM activities WHERE "companyId" = $1 AND "brandId" = $2) AS n`,
    companyId,
    id
  )) as { n: number }[];

  if ((inUse[0]?.n ?? 0) > 0) {
    // Soft-archive instead of hard-delete to preserve historical tags
    await updateBrand(companyId, id, { isArchived: true });
    return { deleted: false, archived: true };
  }

  await prisma.$executeRawUnsafe(
    `DELETE FROM brands WHERE id = $1 AND "companyId" = $2`,
    id,
    companyId
  );
  if (existing.isDefault) await promoteOldestAsDefault(companyId);
  return { deleted: true };
}

// ──────────────────────────────────────────────────────────────────────
// COUNTS per brand (for the switcher badge)
// ──────────────────────────────────────────────────────────────────────

export async function getBrandStats(companyId: string): Promise<
  Array<{
    brandId: string | null;
    customerCount: number;
    dealCount: number;
    activityCount: number;
  }>
> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT
       COALESCE(c."brandId", 'unbranded') AS "brandKey",
       c."brandId" AS "brandId",
       COUNT(DISTINCT c.id)::int AS "customerCount",
       COUNT(DISTINCT d.id)::int AS "dealCount",
       COUNT(DISTINCT a.id)::int AS "activityCount"
     FROM customers c
     LEFT JOIN deals d ON d."customerId" = c.id AND d."companyId" = $1
     LEFT JOIN activities a ON (a."customerId" = c.id OR a."dealId" = d.id)
       AND a."companyId" = $1
     WHERE c."companyId" = $1
     GROUP BY c."brandId"`,
    companyId
  )) as Array<{
    brandKey: string;
    brandId: string | null;
    customerCount: number;
    dealCount: number;
    activityCount: number;
  }>;
  return rows.map((r) => ({
    brandId: r.brandId,
    customerCount: r.customerCount,
    dealCount: r.dealCount,
    activityCount: r.activityCount,
  }));
}
