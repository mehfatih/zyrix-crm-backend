// ============================================================================
// BRAND SETTINGS SERVICE (white-label)
// ----------------------------------------------------------------------------
// CRUD for per-company brand overrides. Tier-gates server-side so
// free/starter plans can't accidentally set custom domains even if they
// manage to reach the API.
//
// Tier matrix:
//   FREE / STARTER: displayName + primary/accent colors only
//   PRO:            + logo/favicon + custom email-from
//   BUSINESS:       + everything in PRO
//   ENTERPRISE:     + custom domain (CNAME)
//
// Plans are the 'plan' column on the Company row. If in doubt we fall
// closed (reject the update) — a bug that lets a paid feature through
// to a lower tier is worse than a brief 403 we can fix.
// ============================================================================

import crypto from "crypto";
import { prisma } from "../config/database";
import { badRequest, notFound } from "../middleware/errorHandler";

export interface BrandSettings {
  id: string;
  companyId: string;
  displayName: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  emailFromName: string | null;
  emailFromAddress: string | null;
  customDomain: string | null;
  customDomainVerifiedAt: string | null;
  customDomainVerificationToken: string | null;
  createdAt: string;
  updatedAt: string;
}

// ──────────────────────────────────────────────────────────────────────
// Tier capabilities
// ──────────────────────────────────────────────────────────────────────

const TIER_RANK: Record<string, number> = {
  free: 0,
  starter: 1,
  pro: 2,
  business: 2,
  enterprise: 3,
};

function tierRank(plan: string | null | undefined): number {
  return TIER_RANK[String(plan ?? "free").toLowerCase()] ?? 0;
}

export function canUseLogo(plan: string | null | undefined): boolean {
  return tierRank(plan) >= 2; // PRO+
}
export function canUseCustomEmail(plan: string | null | undefined): boolean {
  return tierRank(plan) >= 2; // PRO+
}
export function canUseCustomDomain(plan: string | null | undefined): boolean {
  return tierRank(plan) >= 3; // ENTERPRISE only
}

// ──────────────────────────────────────────────────────────────────────
// Validation helpers
// ──────────────────────────────────────────────────────────────────────

function assertValidHexColor(value: string | null | undefined, field: string) {
  if (!value) return;
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw badRequest(`${field} must be a 6-char hex color like #0891C2`);
  }
}

function assertValidUrl(value: string | null | undefined, field: string) {
  if (!value) return;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      throw new Error();
    }
  } catch {
    throw badRequest(`${field} must be a valid URL`);
  }
}

function assertValidDomain(value: string | null | undefined) {
  if (!value) return;
  // Basic domain regex: chars, digits, hyphens, dots. Rejects protocols,
  // paths, or bare IPs. 63 chars per label max.
  if (
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(value.trim())
  ) {
    throw badRequest(
      "customDomain must be a valid hostname like crm.example.com"
    );
  }
}

// ──────────────────────────────────────────────────────────────────────
// Load a company's plan (for tier gating)
// ──────────────────────────────────────────────────────────────────────

async function getCompanyPlan(companyId: string): Promise<string> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { plan: true },
  });
  if (!company) throw notFound("Company");
  return company.plan;
}

// ──────────────────────────────────────────────────────────────────────
// READ
// ──────────────────────────────────────────────────────────────────────

export async function getBrandSettings(
  companyId: string
): Promise<BrandSettings | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id, "companyId", "displayName", "logoUrl", "faviconUrl",
            "primaryColor", "accentColor", "emailFromName", "emailFromAddress",
            "customDomain", "customDomainVerifiedAt", "customDomainVerificationToken",
            "createdAt", "updatedAt"
     FROM brand_settings
     WHERE "companyId" = $1
     LIMIT 1`,
    companyId
  )) as BrandSettings[];
  return rows[0] ?? null;
}

/**
 * Public-facing brand resolver. Called by anonymous routes to render
 * a custom-branded login page based on the domain the user hit.
 * Returns null if no custom branding applies — the frontend then
 * falls back to default Zyrix branding.
 */
export async function getPublicBrandByDomain(
  domain: string
): Promise<{
  displayName: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
} | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT "displayName", "logoUrl", "faviconUrl", "primaryColor", "accentColor"
     FROM brand_settings
     WHERE "customDomain" = $1 AND "customDomainVerifiedAt" IS NOT NULL
     LIMIT 1`,
    domain.toLowerCase().trim()
  )) as Array<{
    displayName: string | null;
    logoUrl: string | null;
    faviconUrl: string | null;
    primaryColor: string | null;
    accentColor: string | null;
  }>;
  return rows[0] ?? null;
}

// ──────────────────────────────────────────────────────────────────────
// UPDATE
// ──────────────────────────────────────────────────────────────────────

export interface UpdateBrandInput {
  displayName?: string | null;
  logoUrl?: string | null;
  faviconUrl?: string | null;
  primaryColor?: string | null;
  accentColor?: string | null;
  emailFromName?: string | null;
  emailFromAddress?: string | null;
}

export async function updateBrandSettings(
  companyId: string,
  dto: UpdateBrandInput
): Promise<BrandSettings> {
  const plan = await getCompanyPlan(companyId);

  // Validation
  if (dto.displayName !== undefined && dto.displayName !== null) {
    if (dto.displayName.length > 100) {
      throw badRequest("displayName max length is 100 chars");
    }
  }
  assertValidHexColor(dto.primaryColor, "primaryColor");
  assertValidHexColor(dto.accentColor, "accentColor");
  assertValidUrl(dto.logoUrl, "logoUrl");
  assertValidUrl(dto.faviconUrl, "faviconUrl");

  // Tier gating
  if (
    (dto.logoUrl !== undefined || dto.faviconUrl !== undefined) &&
    !canUseLogo(plan)
  ) {
    throw badRequest("Custom logos require a Pro plan or higher");
  }
  if (
    (dto.emailFromName !== undefined || dto.emailFromAddress !== undefined) &&
    !canUseCustomEmail(plan)
  ) {
    throw badRequest("Custom email sender requires a Pro plan or higher");
  }

  if (dto.emailFromAddress) {
    // Minimum email sanity check — full validation happens at send time
    // when we hand off to Resend/SMTP.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dto.emailFromAddress)) {
      throw badRequest("emailFromAddress must be a valid email");
    }
  }

  // Upsert the row
  const existing = await getBrandSettings(companyId);
  if (existing) {
    // Build the SET clause dynamically so we only update provided fields.
    // Using parameterized query to be safe.
    const updates: string[] = [];
    const values: any[] = [];
    let i = 1;
    const set = (col: string, val: any) => {
      updates.push(`"${col}" = $${i++}`);
      values.push(val);
    };
    if (dto.displayName !== undefined) set("displayName", dto.displayName);
    if (dto.logoUrl !== undefined) set("logoUrl", dto.logoUrl);
    if (dto.faviconUrl !== undefined) set("faviconUrl", dto.faviconUrl);
    if (dto.primaryColor !== undefined) set("primaryColor", dto.primaryColor);
    if (dto.accentColor !== undefined) set("accentColor", dto.accentColor);
    if (dto.emailFromName !== undefined)
      set("emailFromName", dto.emailFromName);
    if (dto.emailFromAddress !== undefined)
      set("emailFromAddress", dto.emailFromAddress);

    if (updates.length === 0) return existing;

    updates.push(`"updatedAt" = NOW()`);
    values.push(existing.id);
    await prisma.$executeRawUnsafe(
      `UPDATE brand_settings SET ${updates.join(", ")} WHERE id = $${i}`,
      ...values
    );
  } else {
    await prisma.$executeRawUnsafe(
      `INSERT INTO brand_settings
         (id, "companyId", "displayName", "logoUrl", "faviconUrl",
          "primaryColor", "accentColor", "emailFromName", "emailFromAddress",
          "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
      companyId,
      dto.displayName ?? null,
      dto.logoUrl ?? null,
      dto.faviconUrl ?? null,
      dto.primaryColor ?? null,
      dto.accentColor ?? null,
      dto.emailFromName ?? null,
      dto.emailFromAddress ?? null
    );
  }

  const updated = await getBrandSettings(companyId);
  if (!updated) throw notFound("BrandSettings");
  return updated;
}

// ──────────────────────────────────────────────────────────────────────
// CUSTOM DOMAIN — enterprise only, requires DNS verification
// ──────────────────────────────────────────────────────────────────────

export interface SetCustomDomainResult {
  customDomain: string;
  verificationToken: string;
  txtRecord: {
    name: string;
    value: string;
  };
  cnameTarget: string;
}

/**
 * Start custom-domain setup. Generates a verification token the customer
 * adds to DNS as a TXT record; once we detect that record, verifyDomain()
 * flips customDomainVerifiedAt. Uninverified domains don't receive any
 * traffic — verification is a hard gate.
 */
export async function setCustomDomain(
  companyId: string,
  customDomain: string
): Promise<SetCustomDomainResult> {
  const plan = await getCompanyPlan(companyId);
  if (!canUseCustomDomain(plan)) {
    throw badRequest(
      "Custom domains are available on Enterprise plans only. Contact sales to upgrade."
    );
  }
  const normalized = customDomain.toLowerCase().trim();
  assertValidDomain(normalized);

  // Check for domain collision across tenants
  const existing = (await prisma.$queryRawUnsafe(
    `SELECT "companyId" FROM brand_settings WHERE "customDomain" = $1 LIMIT 1`,
    normalized
  )) as { companyId: string }[];
  if (existing.length > 0 && existing[0].companyId !== companyId) {
    throw badRequest(
      "That domain is already registered by another company. Contact support if this is a mistake."
    );
  }

  // Generate a fresh verification token — 16 bytes hex = 32 chars
  const token = `zyrix-verify-${crypto.randomBytes(16).toString("hex")}`;

  const current = await getBrandSettings(companyId);
  if (current) {
    await prisma.$executeRawUnsafe(
      `UPDATE brand_settings
       SET "customDomain" = $1,
           "customDomainVerifiedAt" = NULL,
           "customDomainVerificationToken" = $2,
           "updatedAt" = NOW()
       WHERE id = $3`,
      normalized,
      token,
      current.id
    );
  } else {
    await prisma.$executeRawUnsafe(
      `INSERT INTO brand_settings
         (id, "companyId", "customDomain", "customDomainVerificationToken",
          "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, NOW(), NOW())`,
      companyId,
      normalized,
      token
    );
  }

  return {
    customDomain: normalized,
    verificationToken: token,
    txtRecord: {
      name: `_zyrix-challenge.${normalized}`,
      value: token,
    },
    cnameTarget: "proxy.zyrix.co",
  };
}

/**
 * Verify that the TXT record is in place. Real implementation would
 * dig the DNS server-side; for MVP we record the verification attempt
 * and mark it verified if the token matches what we stored. A follow-up
 * task will wire real DNS lookup via node's dns.resolveTxt().
 */
export async function verifyCustomDomain(
  companyId: string
): Promise<{ verified: boolean; reason?: string }> {
  const settings = await getBrandSettings(companyId);
  if (!settings || !settings.customDomain || !settings.customDomainVerificationToken) {
    throw badRequest("No custom domain pending verification");
  }

  const { customDomain, customDomainVerificationToken } = settings;

  try {
    // Dynamic import so Node's 'dns' module only loads in environments
    // that need it; also makes it mockable from tests.
    const dns = await import("dns");
    const txtRecords: string[][] = await new Promise((resolve, reject) => {
      dns.resolveTxt(`_zyrix-challenge.${customDomain}`, (err, records) => {
        if (err) reject(err);
        else resolve(records as string[][]);
      });
    });
    const flatRecords = txtRecords.flat();
    const found = flatRecords.some((r) => r === customDomainVerificationToken);
    if (!found) {
      return {
        verified: false,
        reason: "TXT record not found — DNS may still be propagating.",
      };
    }
  } catch (e: any) {
    return {
      verified: false,
      reason: `DNS lookup failed: ${e?.code || e?.message || "unknown"}`,
    };
  }

  await prisma.$executeRawUnsafe(
    `UPDATE brand_settings
     SET "customDomainVerifiedAt" = NOW(), "updatedAt" = NOW()
     WHERE "companyId" = $1`,
    companyId
  );
  return { verified: true };
}

export async function removeCustomDomain(
  companyId: string
): Promise<{ removed: true }> {
  await prisma.$executeRawUnsafe(
    `UPDATE brand_settings
     SET "customDomain" = NULL,
         "customDomainVerifiedAt" = NULL,
         "customDomainVerificationToken" = NULL,
         "updatedAt" = NOW()
     WHERE "companyId" = $1`,
    companyId
  );
  return { removed: true };
}

export async function resetBrandSettings(
  companyId: string
): Promise<{ reset: true }> {
  await prisma.$executeRawUnsafe(
    `DELETE FROM brand_settings WHERE "companyId" = $1`,
    companyId
  );
  return { reset: true };
}
