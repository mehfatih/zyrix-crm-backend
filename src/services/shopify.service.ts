// ============================================================================
// SHOPIFY SERVICE — compatibility shim
// Original Shopify-only logic is now part of the generalized ecommerce.service
// This file kept for backward compatibility with existing frontend callers.
// New code should call ecommerce.service directly.
// ============================================================================

import * as EcommerceSvc from "./ecommerce.service";

export interface ConnectStoreDto {
  shopDomain: string;
  accessToken: string;
}

export async function listStores(companyId: string) {
  const all = await EcommerceSvc.listStores(companyId);
  return all
    .filter((s) => s.platform === "shopify")
    .map((s) => ({
      id: s.id,
      shopDomain: s.shopDomain,
      isActive: s.isActive,
      lastSyncAt: s.lastSyncAt,
      syncStatus: s.syncStatus,
      syncError: s.syncError,
      totalCustomersImported: s.totalCustomersImported,
      totalOrdersImported: s.totalOrdersImported,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
}

export async function connectStore(companyId: string, dto: ConnectStoreDto) {
  return EcommerceSvc.connectStore(companyId, {
    platform: "shopify",
    shopDomain: dto.shopDomain,
    accessToken: dto.accessToken,
  });
}

export async function disconnectStore(companyId: string, id: string) {
  return EcommerceSvc.disconnectStore(companyId, id);
}

export async function syncStore(companyId: string, id: string) {
  return EcommerceSvc.syncStore(companyId, id);
}
