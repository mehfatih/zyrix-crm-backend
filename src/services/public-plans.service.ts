import { prisma } from "../config/database";

// ============================================================================
// PUBLIC PLANS SERVICE (for Pricing page — no auth)
// ============================================================================

export async function getPublicPlans() {
  return prisma.plan.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      slug: true,
      name: true,
      nameAr: true,
      nameTr: true,
      description: true,
      descriptionAr: true,
      descriptionTr: true,
      priceMonthlyUsd: true,
      priceYearlyUsd: true,
      priceMonthlyTry: true,
      priceYearlyTry: true,
      priceMonthlySar: true,
      priceYearlySar: true,
      maxUsers: true,
      maxCustomers: true,
      maxDeals: true,
      maxStorageGb: true,
      maxWhatsappMsg: true,
      maxAiTokens: true,
      features: true,
      isFeatured: true,
      color: true,
      sortOrder: true,
    },
  });
}
