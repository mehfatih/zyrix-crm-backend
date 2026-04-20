import { prisma } from "../config/database";
import { notFound } from "../middleware/errorHandler";
import type { Prisma } from "@prisma/client";

// ============================================================================
// SMART FOLLOW-UP SERVICE
// ============================================================================

export interface FollowupSettingsDto {
  isEnabled?: boolean;
  warningDays?: number;
  criticalDays?: number;
  includeStatuses?: string[];
  excludeInactive?: boolean;
}

export interface StaleCustomer {
  id: string;
  fullName: string;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  lastContactAt: string | null;
  lastActivityAt: string | null;
  daysSinceContact: number;
  severity: "warning" | "critical";
  hasOpenDeal: boolean;
  openDealValue: number;
  ownerId: string | null;
  ownerName: string | null;
}

// ─────────────────────────────────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────────────────────────────────
export async function getSettings(companyId: string) {
  const existing = await prisma.followupSettings.findUnique({
    where: { companyId },
  });
  if (existing) return existing;

  // Return defaults without creating the row
  return {
    id: null,
    companyId,
    isEnabled: true,
    warningDays: 5,
    criticalDays: 10,
    includeStatuses: null,
    excludeInactive: true,
    createdAt: null,
    updatedAt: null,
  };
}

export async function upsertSettings(
  companyId: string,
  dto: FollowupSettingsDto
) {
  const warning = dto.warningDays ?? 5;
  const critical = dto.criticalDays ?? 10;
  if (critical < warning) {
    const err: any = new Error("criticalDays must be >= warningDays");
    err.statusCode = 400;
    throw err;
  }

  return prisma.followupSettings.upsert({
    where: { companyId },
    create: {
      companyId,
      isEnabled: dto.isEnabled ?? true,
      warningDays: warning,
      criticalDays: critical,
      includeStatuses: (dto.includeStatuses as any) ?? undefined,
      excludeInactive: dto.excludeInactive ?? true,
    },
    update: {
      ...(dto.isEnabled !== undefined && { isEnabled: dto.isEnabled }),
      ...(dto.warningDays !== undefined && { warningDays: warning }),
      ...(dto.criticalDays !== undefined && { criticalDays: critical }),
      ...(dto.includeStatuses !== undefined && {
        includeStatuses: dto.includeStatuses as any,
      }),
      ...(dto.excludeInactive !== undefined && {
        excludeInactive: dto.excludeInactive,
      }),
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// STALE CUSTOMERS
// ─────────────────────────────────────────────────────────────────────────
export async function getStaleCustomers(companyId: string): Promise<{
  warning: StaleCustomer[];
  critical: StaleCustomer[];
  stats: {
    totalStale: number;
    warningCount: number;
    criticalCount: number;
    openDealValue: number;
  };
}> {
  const settings = await getSettings(companyId);
  const now = Date.now();
  const warningCutoff = new Date(
    now - settings.warningDays * 24 * 60 * 60 * 1000
  );
  const criticalCutoff = new Date(
    now - settings.criticalDays * 24 * 60 * 60 * 1000
  );

  // Build where clause
  const where: Prisma.CustomerWhereInput = { companyId };
  if (settings.excludeInactive) {
    where.status = { notIn: ["lost", "disabled"] };
  }
  if (
    settings.includeStatuses &&
    Array.isArray(settings.includeStatuses) &&
    settings.includeStatuses.length > 0
  ) {
    where.status = { in: settings.includeStatuses as string[] };
  }

  // Find customers whose last contact (either lastContactAt or most recent activity) is older than warningCutoff
  const customers = await prisma.customer.findMany({
    where,
    include: {
      owner: { select: { id: true, fullName: true } },
      activities: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { createdAt: true, type: true },
      },
      deals: {
        where: { stage: { notIn: ["won", "lost"] } },
        select: { id: true, value: true },
      },
    },
  });

  const warning: StaleCustomer[] = [];
  const critical: StaleCustomer[] = [];
  let openDealValueSum = 0;

  for (const c of customers) {
    // Determine last contact time: max(lastContactAt, most recent activity)
    const lastActivity = c.activities[0]?.createdAt ?? null;
    const lastContact = c.lastContactAt ?? null;

    let lastTouch: Date | null = null;
    if (lastActivity && lastContact) {
      lastTouch = lastActivity > lastContact ? lastActivity : lastContact;
    } else {
      lastTouch = lastActivity ?? lastContact ?? c.createdAt;
    }

    if (lastTouch > warningCutoff) continue; // Not stale

    const daysSince = Math.floor(
      (now - lastTouch.getTime()) / (24 * 60 * 60 * 1000)
    );

    const openDealValue = c.deals.reduce(
      (sum, d) => sum + Number(d.value),
      0
    );

    const row: StaleCustomer = {
      id: c.id,
      fullName: c.fullName,
      companyName: c.companyName,
      email: c.email,
      phone: c.phone,
      status: c.status,
      lastContactAt: c.lastContactAt?.toISOString() ?? null,
      lastActivityAt: lastActivity?.toISOString() ?? null,
      daysSinceContact: daysSince,
      severity: lastTouch <= criticalCutoff ? "critical" : "warning",
      hasOpenDeal: c.deals.length > 0,
      openDealValue,
      ownerId: c.owner?.id ?? null,
      ownerName: c.owner?.fullName ?? null,
    };

    if (row.severity === "critical") {
      critical.push(row);
    } else {
      warning.push(row);
    }
    openDealValueSum += openDealValue;
  }

  // Sort: most stale first, then by open-deal-value
  const sortFn = (a: StaleCustomer, b: StaleCustomer) =>
    b.daysSinceContact - a.daysSinceContact || b.openDealValue - a.openDealValue;
  critical.sort(sortFn);
  warning.sort(sortFn);

  return {
    warning,
    critical,
    stats: {
      totalStale: warning.length + critical.length,
      warningCount: warning.length,
      criticalCount: critical.length,
      openDealValue: Math.round(openDealValueSum * 100) / 100,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// CREATE FOLLOW-UP TASK
// ─────────────────────────────────────────────────────────────────────────
export async function createFollowupTask(
  companyId: string,
  userId: string,
  customerId: string
) {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, companyId },
    select: {
      id: true,
      fullName: true,
      companyName: true,
      ownerId: true,
    },
  });
  if (!customer) throw notFound("Customer");

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 1); // Tomorrow

  return prisma.task.create({
    data: {
      companyId,
      createdById: userId,
      assignedToId: customer.ownerId ?? userId,
      customerId: customer.id,
      title: `Follow up with ${customer.fullName}${customer.companyName ? ` (${customer.companyName})` : ""}`,
      description: `Auto-generated follow-up task. This customer has not been contacted recently — reach out via phone, email, or WhatsApp to re-engage.`,
      status: "todo",
      priority: "high",
      dueDate,
    },
    include: {
      customer: { select: { id: true, fullName: true, companyName: true } },
      assignedTo: { select: { id: true, fullName: true, email: true } },
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// BULK CREATE (all critical)
// ─────────────────────────────────────────────────────────────────────────
export async function bulkCreateFollowupTasks(
  companyId: string,
  userId: string,
  customerIds: string[]
) {
  let created = 0;
  let skipped = 0;

  for (const id of customerIds) {
    try {
      await createFollowupTask(companyId, userId, id);
      created++;
    } catch {
      skipped++;
    }
  }

  return { created, skipped, total: customerIds.length };
}
