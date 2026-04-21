import { prisma } from "../config/database";

// ============================================================================
// ROLE-BASED DASHBOARD SERVICE
// Different KPIs based on user role:
// - member: only their own deals/tasks
// - manager: team performance
// - admin/owner/super_admin: full company view
// ============================================================================

export type UserRole =
  | "super_admin"
  | "owner"
  | "admin"
  | "manager"
  | "member";

export async function getDashboardStats(
  companyId: string,
  userId: string,
  role: UserRole
) {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // For member role, scope everything to the user
  const isPersonalView = role === "member";
  const dealFilter = isPersonalView
    ? { companyId, ownerId: userId }
    : { companyId };
  const taskFilter = isPersonalView
    ? { companyId, assignedToId: userId }
    : { companyId };
  const customerFilter = isPersonalView
    ? { companyId, ownerId: userId }
    : { companyId };

  // Base queries (run in parallel)
  const [
    customerTotal,
    customerNew30d,
    dealTotal,
    dealOpen,
    dealWon30d,
    dealLost30d,
    dealWonValue,
    pipelineAggregate,
    allOpenDeals,
    taskOpen,
    taskOverdue,
    taskCompleted7d,
    activityLast7d,
  ] = await Promise.all([
    prisma.customer.count({ where: customerFilter }),
    prisma.customer.count({
      where: { ...customerFilter, createdAt: { gte: thirtyDaysAgo } },
    }),
    prisma.deal.count({ where: dealFilter }),
    prisma.deal.count({
      where: { ...dealFilter, stage: { notIn: ["won", "lost"] } },
    }),
    prisma.deal.count({
      where: {
        ...dealFilter,
        stage: "won",
        actualCloseDate: { gte: thirtyDaysAgo },
      },
    }),
    prisma.deal.count({
      where: {
        ...dealFilter,
        stage: "lost",
        actualCloseDate: { gte: thirtyDaysAgo },
      },
    }),
    prisma.deal.aggregate({
      where: {
        ...dealFilter,
        stage: "won",
        actualCloseDate: { gte: thirtyDaysAgo },
      },
      _sum: { value: true },
    }),
    prisma.deal.aggregate({
      where: { ...dealFilter, stage: { notIn: ["won", "lost"] } },
      _sum: { value: true },
    }),
    prisma.deal.findMany({
      where: { ...dealFilter, stage: { notIn: ["won", "lost"] } },
      select: { value: true, probability: true, stage: true },
    }),
    prisma.task.count({
      where: { ...taskFilter, status: { in: ["todo", "in_progress"] } },
    }),
    prisma.task.count({
      where: {
        ...taskFilter,
        status: { in: ["todo", "in_progress"] },
        dueDate: { lt: now },
      },
    }),
    prisma.task.count({
      where: {
        ...taskFilter,
        status: "done",
        updatedAt: { gte: sevenDaysAgo },
      },
    }),
    prisma.activity.count({
      where: isPersonalView
        ? { companyId, userId, createdAt: { gte: sevenDaysAgo } }
        : { companyId, createdAt: { gte: sevenDaysAgo } },
    }),
  ]);

  // Weighted pipeline + stage breakdown
  let weightedPipeline = 0;
  const byStage: Record<string, { count: number; value: number }> = {};
  for (const d of allOpenDeals) {
    const v = Number(d.value);
    weightedPipeline += (v * d.probability) / 100;
    const s = byStage[d.stage] ?? { count: 0, value: 0 };
    s.count++;
    s.value += v;
    byStage[d.stage] = s;
  }

  // Base stats (available to everyone)
  const base = {
    customers: {
      total: customerTotal,
      new30d: customerNew30d,
    },
    deals: {
      total: dealTotal,
      open: dealOpen,
      wonLast30d: dealWon30d,
      lostLast30d: dealLost30d,
      wonValueLast30d:
        Math.round(Number(dealWonValue._sum.value ?? 0) * 100) / 100,
      pipelineValue:
        Math.round(Number(pipelineAggregate._sum.value ?? 0) * 100) / 100,
      weightedPipelineValue: Math.round(weightedPipeline * 100) / 100,
      byStage,
    },
    tasks: {
      open: taskOpen,
      overdue: taskOverdue,
      completedLast7d: taskCompleted7d,
    },
    activities: {
      last7d: activityLast7d,
    },
  };

  // Role-specific additions
  if (role === "member") {
    // Members: only their stuff + upcoming tasks today
    const upcomingTasks = await prisma.task.findMany({
      where: {
        companyId,
        assignedToId: userId,
        status: { in: ["todo", "in_progress"] },
      },
      orderBy: [{ priority: "desc" }, { dueDate: "asc" }],
      take: 5,
      select: {
        id: true,
        title: true,
        priority: true,
        dueDate: true,
        customer: { select: { id: true, fullName: true } },
      },
    });

    const myOpenDeals = await prisma.deal.findMany({
      where: {
        companyId,
        ownerId: userId,
        stage: { notIn: ["won", "lost"] },
      },
      orderBy: { updatedAt: "desc" },
      take: 5,
      select: {
        id: true,
        title: true,
        stage: true,
        value: true,
        currency: true,
        customer: { select: { id: true, fullName: true } },
      },
    });

    return {
      role,
      scope: "personal" as const,
      ...base,
      upcomingTasks,
      myOpenDeals,
    };
  }

  if (role === "manager") {
    // Managers: team leaderboard
    const teamDeals = await prisma.deal.groupBy({
      by: ["ownerId"],
      where: {
        companyId,
        ownerId: { not: null },
        stage: "won",
        actualCloseDate: { gte: thirtyDaysAgo },
      },
      _sum: { value: true },
      _count: { id: true },
    });

    const ownerIds = teamDeals
      .map((t) => t.ownerId)
      .filter((id): id is string => !!id);
    const users = ownerIds.length
      ? await prisma.user.findMany({
          where: { id: { in: ownerIds }, companyId },
          select: { id: true, fullName: true, email: true, role: true },
        })
      : [];
    const userMap = new Map(users.map((u) => [u.id, u]));

    const teamLeaderboard = teamDeals
      .filter((t) => t.ownerId && userMap.has(t.ownerId))
      .map((t) => ({
        user: userMap.get(t.ownerId!)!,
        dealsWon: t._count.id,
        revenue: Math.round(Number(t._sum.value ?? 0) * 100) / 100,
      }))
      .sort((a, b) => b.revenue - a.revenue);

    return {
      role,
      scope: "team" as const,
      ...base,
      teamLeaderboard,
    };
  }

  // Admin / Owner / Super-admin — full company view
  const [
    totalUsers,
    totalQuotesValue,
    totalContractsActive,
    topCustomers,
  ] = await Promise.all([
    prisma.user.count({ where: { companyId } }),
    prisma.quote.aggregate({
      where: {
        companyId,
        status: "accepted",
        acceptedAt: { gte: thirtyDaysAgo },
      },
      _sum: { total: true },
    }),
    prisma.contract.count({
      where: {
        companyId,
        status: { in: ["active", "signed"] },
      },
    }),
    prisma.customer.findMany({
      where: { companyId },
      orderBy: { lifetimeValue: "desc" },
      take: 5,
      select: {
        id: true,
        fullName: true,
        companyName: true,
        lifetimeValue: true,
      },
    }),
  ]);

  // Team leaderboard
  const teamDeals = await prisma.deal.groupBy({
    by: ["ownerId"],
    where: {
      companyId,
      ownerId: { not: null },
      stage: "won",
      actualCloseDate: { gte: thirtyDaysAgo },
    },
    _sum: { value: true },
    _count: { id: true },
  });
  const ownerIds = teamDeals
    .map((t) => t.ownerId)
    .filter((id): id is string => !!id);
  const users = ownerIds.length
    ? await prisma.user.findMany({
        where: { id: { in: ownerIds }, companyId },
        select: { id: true, fullName: true, email: true, role: true },
      })
    : [];
  const userMap = new Map(users.map((u) => [u.id, u]));
  const teamLeaderboard = teamDeals
    .filter((t) => t.ownerId && userMap.has(t.ownerId))
    .map((t) => ({
      user: userMap.get(t.ownerId!)!,
      dealsWon: t._count.id,
      revenue: Math.round(Number(t._sum.value ?? 0) * 100) / 100,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  return {
    role,
    scope: "company" as const,
    ...base,
    company: {
      totalUsers,
      acceptedQuotesValue30d:
        Math.round(Number(totalQuotesValue._sum.total ?? 0) * 100) / 100,
      activeContracts: totalContractsActive,
    },
    topCustomers: topCustomers.map((c) => ({
      ...c,
      lifetimeValue: Number(c.lifetimeValue),
    })),
    teamLeaderboard,
  };
}
