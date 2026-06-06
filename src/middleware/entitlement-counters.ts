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
