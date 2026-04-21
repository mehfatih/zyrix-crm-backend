// ============================================================================
// AI AGENT TOOLS
// ----------------------------------------------------------------------------
// Function-calling tools the Sales Assistant (and other agents) can invoke
// to query the company's CRM data. Each tool is scoped to companyId so
// Gemini can't leak data across tenants — the assistant always sees only
// the caller's company.
//
// Tool schema is returned to Gemini at each chat turn. When Gemini decides
// to call a tool, we execute it server-side and feed the result back into
// the conversation. The next turn's response is grounded in real data.
// ============================================================================

import { prisma } from "../config/database";
import type { Prisma } from "@prisma/client";

// ──────────────────────────────────────────────────────────────────────
// TOOL DECLARATIONS (Gemini function-calling schema)
// ──────────────────────────────────────────────────────────────────────

export const SALES_AGENT_TOOLS = [
  {
    name: "search_customers",
    description:
      "Search customers by name, email, phone, or company name. Returns up to 10 matches with their basic info.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search text — name, email, phone fragment, or company",
        },
        status: {
          type: "string",
          description: "Optional status filter (e.g. 'customer', 'lead')",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_customer_details",
    description:
      "Get full details for one customer by ID, including their recent deals and activities.",
    parameters: {
      type: "object",
      properties: {
        customerId: {
          type: "string",
          description: "The customer's UUID",
        },
      },
      required: ["customerId"],
    },
  },
  {
    name: "list_deals",
    description:
      "List deals with optional filters. Useful for queries like 'what deals are in negotiation' or 'show me deals over $10k'.",
    parameters: {
      type: "object",
      properties: {
        stage: {
          type: "string",
          description: "Pipeline stage filter (lead, qualified, proposal, negotiation, won, lost)",
        },
        minValue: {
          type: "number",
          description: "Minimum deal value",
        },
        customerId: {
          type: "string",
          description: "Filter to deals for a specific customer",
        },
        limit: {
          type: "number",
          description: "Max results, default 10",
        },
      },
    },
  },
  {
    name: "get_pipeline_summary",
    description:
      "Return totals by pipeline stage — deal counts and total value per stage.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "get_upcoming_tasks",
    description:
      "List the current user's upcoming tasks (not yet completed), sorted by due date.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results, default 10" },
      },
    },
  },
  {
    name: "get_stale_deals",
    description:
      "Find deals that haven't been updated recently — good for suggesting follow-ups. Default threshold is 14 days.",
    parameters: {
      type: "object",
      properties: {
        daysStale: {
          type: "number",
          description: "How many days of inactivity count as stale",
        },
        limit: { type: "number", description: "Max results, default 10" },
      },
    },
  },
  {
    name: "get_recent_activity",
    description:
      "Recent activities (calls, meetings, notes, emails) across the company. Useful for 'what happened this week' queries.",
    parameters: {
      type: "object",
      properties: {
        days: {
          type: "number",
          description: "Look back window in days, default 7",
        },
        limit: { type: "number", description: "Max results, default 20" },
      },
    },
  },
];

// ──────────────────────────────────────────────────────────────────────
// TOOL EXECUTORS
// ──────────────────────────────────────────────────────────────────────
// Each executor takes (companyId, userId, args) and returns a plain object
// that's JSON-stringifiable. Execution errors are caught and returned as
// { error: '...' } so the conversation can continue even if a tool fails.

export interface ToolContext {
  companyId: string;
  userId: string;
}

export async function executeTool(
  name: string,
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<unknown> {
  try {
    switch (name) {
      case "search_customers":
        return await searchCustomers(ctx, args);
      case "get_customer_details":
        return await getCustomerDetails(ctx, args);
      case "list_deals":
        return await listDeals(ctx, args);
      case "get_pipeline_summary":
        return await getPipelineSummary(ctx);
      case "get_upcoming_tasks":
        return await getUpcomingTasks(ctx, args);
      case "get_stale_deals":
        return await getStaleDeals(ctx, args);
      case "get_recent_activity":
        return await getRecentActivity(ctx, args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: (e as Error).message };
  }
}

async function searchCustomers(
  ctx: ToolContext,
  args: Record<string, unknown>
) {
  const query = String(args.query ?? "").trim();
  if (!query) return { error: "query is required" };
  const status = typeof args.status === "string" ? args.status : undefined;

  const where: Prisma.CustomerWhereInput = {
    companyId: ctx.companyId,
    ...(status && { status }),
    OR: [
      { fullName: { contains: query, mode: "insensitive" } },
      { email: { contains: query, mode: "insensitive" } },
      { phone: { contains: query } },
      { companyName: { contains: query, mode: "insensitive" } },
    ],
  };
  const customers = await prisma.customer.findMany({
    where,
    take: 10,
    select: {
      id: true,
      fullName: true,
      email: true,
      phone: true,
      companyName: true,
      status: true,
      lifetimeValue: true,
      createdAt: true,
    },
  });
  return {
    count: customers.length,
    customers: customers.map((c) => ({
      ...c,
      lifetimeValue: Number(c.lifetimeValue ?? 0),
    })),
  };
}

async function getCustomerDetails(
  ctx: ToolContext,
  args: Record<string, unknown>
) {
  const customerId = String(args.customerId ?? "");
  if (!customerId) return { error: "customerId is required" };
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, companyId: ctx.companyId },
    include: {
      deals: {
        take: 5,
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          title: true,
          value: true,
          currency: true,
          stage: true,
          updatedAt: true,
        },
      },
      activities: {
        take: 5,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          type: true,
          title: true,
          createdAt: true,
          completedAt: true,
        },
      },
    },
  });
  if (!customer) return { error: "Customer not found" };
  return {
    ...customer,
    lifetimeValue: Number(customer.lifetimeValue ?? 0),
    deals: customer.deals.map((d) => ({ ...d, value: Number(d.value) })),
  };
}

async function listDeals(ctx: ToolContext, args: Record<string, unknown>) {
  const where: Prisma.DealWhereInput = { companyId: ctx.companyId };
  if (typeof args.stage === "string") where.stage = args.stage;
  if (typeof args.customerId === "string") where.customerId = args.customerId;
  if (typeof args.minValue === "number") {
    where.value = { gte: args.minValue };
  }
  const limit = Math.min(Number(args.limit ?? 10), 25);
  const deals = await prisma.deal.findMany({
    where,
    take: limit,
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      value: true,
      currency: true,
      stage: true,
      probability: true,
      updatedAt: true,
      customer: { select: { id: true, fullName: true, companyName: true } },
    },
  });
  return {
    count: deals.length,
    deals: deals.map((d) => ({ ...d, value: Number(d.value) })),
  };
}

async function getPipelineSummary(ctx: ToolContext) {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT stage, COUNT(*)::int AS count, COALESCE(SUM(value), 0)::float AS "totalValue"
     FROM deals
     WHERE "companyId" = $1 AND stage NOT IN ('won', 'lost')
     GROUP BY stage
     ORDER BY stage`,
    ctx.companyId
  )) as { stage: string; count: number; totalValue: number }[];
  const total = rows.reduce((s, r) => s + r.totalValue, 0);
  return { stages: rows, totalOpenValue: total };
}

async function getUpcomingTasks(
  ctx: ToolContext,
  args: Record<string, unknown>
) {
  const limit = Math.min(Number(args.limit ?? 10), 25);
  const tasks = await prisma.activity.findMany({
    where: {
      companyId: ctx.companyId,
      assignedToId: ctx.userId,
      type: "task",
      completedAt: null,
    },
    take: limit,
    orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
    select: {
      id: true,
      title: true,
      dueDate: true,
      createdAt: true,
      customer: { select: { id: true, fullName: true } },
    },
  });
  return { count: tasks.length, tasks };
}

async function getStaleDeals(
  ctx: ToolContext,
  args: Record<string, unknown>
) {
  const days = Math.max(Number(args.daysStale ?? 14), 1);
  const limit = Math.min(Number(args.limit ?? 10), 25);
  const threshold = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const deals = await prisma.deal.findMany({
    where: {
      companyId: ctx.companyId,
      stage: { notIn: ["won", "lost"] },
      updatedAt: { lt: threshold },
    },
    take: limit,
    orderBy: { updatedAt: "asc" },
    select: {
      id: true,
      title: true,
      value: true,
      currency: true,
      stage: true,
      updatedAt: true,
      customer: { select: { id: true, fullName: true } },
    },
  });
  return {
    thresholdDays: days,
    count: deals.length,
    deals: deals.map((d) => ({
      ...d,
      value: Number(d.value),
      daysSinceUpdate: Math.floor(
        (Date.now() - new Date(d.updatedAt).getTime()) / (24 * 60 * 60 * 1000)
      ),
    })),
  };
}

async function getRecentActivity(
  ctx: ToolContext,
  args: Record<string, unknown>
) {
  const days = Math.max(Number(args.days ?? 7), 1);
  const limit = Math.min(Number(args.limit ?? 20), 50);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const activities = await prisma.activity.findMany({
    where: {
      companyId: ctx.companyId,
      createdAt: { gte: since },
    },
    take: limit,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      type: true,
      title: true,
      createdAt: true,
      completedAt: true,
      customer: { select: { id: true, fullName: true } },
    },
  });
  return { days, count: activities.length, activities };
}
