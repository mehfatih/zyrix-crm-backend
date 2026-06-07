// Sprint 16B — per-company usage counters for enforceLimit(). One definition
// each so the limit feature key and its count query stay together.
import { prisma } from "../config/database";

export const countContacts = (companyId: string) =>
  prisma.customer.count({ where: { companyId, deletedAt: null } });

export const countProducts = (companyId: string) =>
  prisma.product.count({ where: { companyId } });

export const countForms = (companyId: string) =>
  prisma.formFlow.count({ where: { companyId, status: { not: "archived" } } });

export const countActiveWorkflows = (companyId: string) =>
  prisma.workflow.count({ where: { companyId, isEnabled: true } });

export const countActiveCadences = (companyId: string) =>
  prisma.cadence.count({ where: { companyId, status: "active" } });

export const countStores = (companyId: string) =>
  prisma.ecommerceStore.count({ where: { companyId } });

export const countUsers = (companyId: string) =>
  prisma.user.count({ where: { companyId, status: { not: "deleted" } } });

// Sprint 20 — landing_pages is a raw-SQL table (no Prisma model); count via SQL.
export const countLandingPages = (companyId: string) =>
  prisma
    .$queryRawUnsafe(`SELECT count(*)::int AS c FROM landing_pages WHERE "companyId" = $1`, companyId)
    .then((r) => Number((r as Array<{ c: number }>)[0]?.c ?? 0));
