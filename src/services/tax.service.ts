import { prisma } from "../config/database";
import { notFound } from "../middleware/errorHandler";
import type { Prisma } from "@prisma/client";

// ============================================================================
// TAX SERVICE
// ============================================================================

export interface CreateTaxRateDto {
  name: string;
  code?: string;
  countryCode?: string;
  ratePercent: number;
  isDefault?: boolean;
  isActive?: boolean;
  description?: string;
}

export interface UpdateTaxRateDto extends Partial<CreateTaxRateDto> {}

// Preset rates by country
const PRESETS: Record<
  string,
  { name: string; code: string; ratePercent: number; isDefault?: boolean }[]
> = {
  TR: [
    { name: "KDV %0", code: "KDV_0", ratePercent: 0 },
    { name: "KDV %1", code: "KDV_1", ratePercent: 1 },
    { name: "KDV %8", code: "KDV_8", ratePercent: 8 },
    { name: "KDV %10", code: "KDV_10", ratePercent: 10 },
    { name: "KDV %18", code: "KDV_18", ratePercent: 18 },
    { name: "KDV %20", code: "KDV_20", ratePercent: 20, isDefault: true },
  ],
  SA: [
    { name: "VAT 0%", code: "VAT_0", ratePercent: 0 },
    { name: "VAT 15%", code: "VAT_15", ratePercent: 15, isDefault: true },
  ],
  AE: [
    { name: "VAT 0%", code: "VAT_0", ratePercent: 0 },
    { name: "VAT 5%", code: "VAT_5", ratePercent: 5, isDefault: true },
  ],
  EG: [
    { name: "VAT 0%", code: "VAT_0", ratePercent: 0 },
    { name: "VAT 14%", code: "VAT_14", ratePercent: 14, isDefault: true },
  ],
  QA: [
    { name: "No VAT", code: "NONE", ratePercent: 0, isDefault: true },
  ],
  KW: [
    { name: "No VAT", code: "NONE", ratePercent: 0, isDefault: true },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// LIST
// ─────────────────────────────────────────────────────────────────────────
export async function listTaxRates(
  companyId: string,
  q: { countryCode?: string; activeOnly?: boolean } = {}
) {
  const where: Prisma.TaxRateWhereInput = { companyId };
  if (q.countryCode) where.countryCode = q.countryCode;
  if (q.activeOnly) where.isActive = true;

  return prisma.taxRate.findMany({
    where,
    orderBy: [
      { isDefault: "desc" },
      { countryCode: "asc" },
      { ratePercent: "asc" },
    ],
  });
}

// ─────────────────────────────────────────────────────────────────────────
// GET ONE
// ─────────────────────────────────────────────────────────────────────────
export async function getTaxRate(companyId: string, id: string) {
  const rate = await prisma.taxRate.findFirst({
    where: { id, companyId },
  });
  if (!rate) throw notFound("Tax rate");
  return rate;
}

// ─────────────────────────────────────────────────────────────────────────
// CREATE
// ─────────────────────────────────────────────────────────────────────────
export async function createTaxRate(
  companyId: string,
  dto: CreateTaxRateDto
) {
  // If this new rate is default, unset other defaults for same country
  if (dto.isDefault) {
    await prisma.taxRate.updateMany({
      where: {
        companyId,
        countryCode: dto.countryCode ?? null,
        isDefault: true,
      },
      data: { isDefault: false },
    });
  }

  return prisma.taxRate.create({
    data: {
      companyId,
      name: dto.name.trim(),
      code: dto.code?.trim() || null,
      countryCode: dto.countryCode?.toUpperCase() || null,
      ratePercent: dto.ratePercent,
      isDefault: dto.isDefault ?? false,
      isActive: dto.isActive ?? true,
      description: dto.description?.trim() || null,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// UPDATE
// ─────────────────────────────────────────────────────────────────────────
export async function updateTaxRate(
  companyId: string,
  id: string,
  dto: UpdateTaxRateDto
) {
  const existing = await prisma.taxRate.findFirst({
    where: { id, companyId },
  });
  if (!existing) throw notFound("Tax rate");

  if (dto.isDefault) {
    await prisma.taxRate.updateMany({
      where: {
        companyId,
        countryCode:
          (dto.countryCode ?? existing.countryCode)?.toUpperCase() ?? null,
        isDefault: true,
        id: { not: id },
      },
      data: { isDefault: false },
    });
  }

  const data: Prisma.TaxRateUpdateInput = {};
  if (dto.name !== undefined) data.name = dto.name.trim();
  if (dto.code !== undefined) data.code = dto.code?.trim() || null;
  if (dto.countryCode !== undefined)
    data.countryCode = dto.countryCode?.toUpperCase() || null;
  if (dto.ratePercent !== undefined) data.ratePercent = dto.ratePercent;
  if (dto.isDefault !== undefined) data.isDefault = dto.isDefault;
  if (dto.isActive !== undefined) data.isActive = dto.isActive;
  if (dto.description !== undefined)
    data.description = dto.description?.trim() || null;

  return prisma.taxRate.update({ where: { id }, data });
}

// ─────────────────────────────────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────────────────────────────────
export async function deleteTaxRate(companyId: string, id: string) {
  const existing = await prisma.taxRate.findFirst({
    where: { id, companyId },
    select: { id: true },
  });
  if (!existing) throw notFound("Tax rate");
  await prisma.taxRate.delete({ where: { id } });
  return { deleted: true };
}

// ─────────────────────────────────────────────────────────────────────────
// SEED PRESETS — idempotent: only adds if no rate with same (countryCode, code)
// ─────────────────────────────────────────────────────────────────────────
export async function seedPresets(companyId: string, countryCode: string) {
  const country = countryCode.toUpperCase();
  const presets = PRESETS[country];
  if (!presets) {
    const err: any = new Error(`No presets available for country: ${country}`);
    err.statusCode = 400;
    throw err;
  }

  let created = 0;
  let skipped = 0;

  for (const p of presets) {
    const existing = await prisma.taxRate.findFirst({
      where: {
        companyId,
        countryCode: country,
        code: p.code,
      },
      select: { id: true },
    });
    if (existing) {
      skipped++;
      continue;
    }

    // Unset previous default for this country
    if (p.isDefault) {
      await prisma.taxRate.updateMany({
        where: { companyId, countryCode: country, isDefault: true },
        data: { isDefault: false },
      });
    }

    await prisma.taxRate.create({
      data: {
        companyId,
        name: p.name,
        code: p.code,
        countryCode: country,
        ratePercent: p.ratePercent,
        isDefault: p.isDefault ?? false,
        isActive: true,
      },
    });
    created++;
  }

  return {
    country,
    created,
    skipped,
    total: presets.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// AVAILABLE PRESETS LISTING
// ─────────────────────────────────────────────────────────────────────────
export function availablePresets() {
  return Object.entries(PRESETS).map(([country, rates]) => ({
    countryCode: country,
    rateCount: rates.length,
    rates,
  }));
}

// ─────────────────────────────────────────────────────────────────────────
// Tax calculation helper (pure — no DB)
// ─────────────────────────────────────────────────────────────────────────
export function calculateTax(
  amount: number,
  ratePercent: number
): { taxAmount: number; grossAmount: number } {
  const taxAmount = Math.round(amount * (ratePercent / 100) * 100) / 100;
  const grossAmount = Math.round((amount + taxAmount) * 100) / 100;
  return { taxAmount, grossAmount };
}
