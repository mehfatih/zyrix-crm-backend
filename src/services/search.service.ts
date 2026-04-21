import { prisma } from "../config/database";

// ============================================================================
// ADVANCED SEARCH SERVICE
// Unified cross-entity search + entity-specific advanced filters
// ============================================================================

export type SearchEntityType =
  | "customers"
  | "deals"
  | "quotes"
  | "contracts"
  | "tasks";

// ──────────────────────────────────────────────────────────────────────
// GLOBAL SEARCH — simple text across all entities
// ──────────────────────────────────────────────────────────────────────
export interface GlobalSearchResult {
  customers: Array<{
    id: string;
    fullName: string;
    email: string | null;
    phone: string | null;
    companyName: string | null;
    status: string;
  }>;
  deals: Array<{
    id: string;
    title: string;
    stage: string;
    value: string;
    currency: string;
    customerId: string;
    customerName: string;
  }>;
  quotes: Array<{
    id: string;
    quoteNumber: string;
    title: string;
    status: string;
    total: string;
    currency: string;
    customerName: string;
  }>;
  contracts: Array<{
    id: string;
    contractNumber: string;
    title: string;
    status: string;
    value: string;
    currency: string;
    customerName: string;
  }>;
  tasks: Array<{
    id: string;
    title: string;
    status: string;
    priority: string;
    dueDate: string | null;
  }>;
  totalMatches: number;
}

export async function globalSearch(
  companyId: string,
  query: string
): Promise<GlobalSearchResult> {
  const q = query.trim();
  if (q.length < 2) {
    return {
      customers: [],
      deals: [],
      quotes: [],
      contracts: [],
      tasks: [],
      totalMatches: 0,
    };
  }

  const limit = 5; // per entity

  const [customers, deals, quotes, contracts, tasks] = await Promise.all([
    prisma.customer.findMany({
      where: {
        companyId,
        OR: [
          { fullName: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
          { phone: { contains: q } },
          { whatsappPhone: { contains: q } },
          { companyName: { contains: q, mode: "insensitive" } },
        ],
      },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        companyName: true,
        status: true,
      },
      take: limit,
      orderBy: { createdAt: "desc" },
    }),
    prisma.deal.findMany({
      where: {
        companyId,
        OR: [
          { title: { contains: q, mode: "insensitive" } },
          { description: { contains: q, mode: "insensitive" } },
        ],
      },
      select: {
        id: true,
        title: true,
        stage: true,
        value: true,
        currency: true,
        customerId: true,
        customer: { select: { fullName: true } },
      },
      take: limit,
      orderBy: { createdAt: "desc" },
    }),
    prisma.quote.findMany({
      where: {
        companyId,
        OR: [
          { title: { contains: q, mode: "insensitive" } },
          { quoteNumber: { contains: q, mode: "insensitive" } },
        ],
      },
      select: {
        id: true,
        quoteNumber: true,
        title: true,
        status: true,
        total: true,
        currency: true,
        customer: { select: { fullName: true } },
      },
      take: limit,
      orderBy: { createdAt: "desc" },
    }),
    prisma.contract.findMany({
      where: {
        companyId,
        OR: [
          { title: { contains: q, mode: "insensitive" } },
          { contractNumber: { contains: q, mode: "insensitive" } },
        ],
      },
      select: {
        id: true,
        contractNumber: true,
        title: true,
        status: true,
        value: true,
        currency: true,
        customer: { select: { fullName: true } },
      },
      take: limit,
      orderBy: { createdAt: "desc" },
    }),
    prisma.task.findMany({
      where: {
        companyId,
        OR: [
          { title: { contains: q, mode: "insensitive" } },
          { description: { contains: q, mode: "insensitive" } },
        ],
      },
      select: {
        id: true,
        title: true,
        status: true,
        priority: true,
        dueDate: true,
      },
      take: limit,
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const result: GlobalSearchResult = {
    customers: customers.map((c) => ({
      id: c.id,
      fullName: c.fullName,
      email: c.email,
      phone: c.phone,
      companyName: c.companyName,
      status: c.status,
    })),
    deals: deals.map((d) => ({
      id: d.id,
      title: d.title,
      stage: d.stage,
      value: String(d.value),
      currency: d.currency,
      customerId: d.customerId,
      customerName: d.customer.fullName,
    })),
    quotes: quotes.map((q) => ({
      id: q.id,
      quoteNumber: q.quoteNumber,
      title: q.title,
      status: q.status,
      total: String(q.total),
      currency: q.currency,
      customerName: q.customer?.fullName || "",
    })),
    contracts: contracts.map((c) => ({
      id: c.id,
      contractNumber: c.contractNumber,
      title: c.title,
      status: c.status,
      value: String(c.value),
      currency: c.currency,
      customerName: c.customer?.fullName || "",
    })),
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      dueDate: t.dueDate?.toISOString() || null,
    })),
    totalMatches: 0,
  };

  result.totalMatches =
    result.customers.length +
    result.deals.length +
    result.quotes.length +
    result.contracts.length +
    result.tasks.length;

  return result;
}

// ──────────────────────────────────────────────────────────────────────
// ADVANCED FILTER — structured filters for a single entity type
// ──────────────────────────────────────────────────────────────────────
export interface FilterCondition {
  field: string;
  operator:
    | "equals"
    | "contains"
    | "starts_with"
    | "not_equals"
    | "greater_than"
    | "less_than"
    | "greater_or_equal"
    | "less_or_equal"
    | "in"
    | "not_in"
    | "is_empty"
    | "is_not_empty"
    | "between";
  value?: any;
  value2?: any; // for between
}

export interface AdvancedFilterRequest {
  entityType: SearchEntityType;
  conditions: FilterCondition[];
  logic?: "AND" | "OR";
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  page?: number;
  limit?: number;
}

function buildWhereClause(
  companyId: string,
  conditions: FilterCondition[],
  logic: "AND" | "OR"
): any {
  const filterClauses: any[] = [];

  for (const cond of conditions) {
    const clause = buildSingleClause(cond);
    if (clause) filterClauses.push(clause);
  }

  if (filterClauses.length === 0) return { companyId };
  if (filterClauses.length === 1) return { companyId, ...filterClauses[0] };

  return logic === "OR"
    ? { companyId, OR: filterClauses }
    : { companyId, AND: filterClauses };
}

function buildSingleClause(cond: FilterCondition): any | null {
  const { field, operator, value, value2 } = cond;
  if (!field) return null;

  switch (operator) {
    case "equals":
      return { [field]: value };
    case "not_equals":
      return { [field]: { not: value } };
    case "contains":
      return { [field]: { contains: String(value), mode: "insensitive" } };
    case "starts_with":
      return { [field]: { startsWith: String(value), mode: "insensitive" } };
    case "greater_than":
      return { [field]: { gt: coerceNumberOrDate(value) } };
    case "less_than":
      return { [field]: { lt: coerceNumberOrDate(value) } };
    case "greater_or_equal":
      return { [field]: { gte: coerceNumberOrDate(value) } };
    case "less_or_equal":
      return { [field]: { lte: coerceNumberOrDate(value) } };
    case "in":
      if (!Array.isArray(value) || value.length === 0) return null;
      return { [field]: { in: value } };
    case "not_in":
      if (!Array.isArray(value) || value.length === 0) return null;
      return { [field]: { notIn: value } };
    case "is_empty":
      return { OR: [{ [field]: null }, { [field]: "" }] };
    case "is_not_empty":
      return { AND: [{ [field]: { not: null } }, { [field]: { not: "" } }] };
    case "between":
      if (value === undefined || value2 === undefined) return null;
      return {
        [field]: {
          gte: coerceNumberOrDate(value),
          lte: coerceNumberOrDate(value2),
        },
      };
    default:
      return null;
  }
}

function coerceNumberOrDate(value: any): any {
  if (value === null || value === undefined) return value;
  // ISO date string
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return new Date(value);
  }
  // Number
  if (!isNaN(Number(value))) return Number(value);
  return value;
}

// ──────────────────────────────────────────────────────────────────────
// Available fields per entity (whitelist for security)
// ──────────────────────────────────────────────────────────────────────
export const ALLOWED_FIELDS: Record<SearchEntityType, string[]> = {
  customers: [
    "fullName", "email", "phone", "whatsappPhone", "companyName",
    "position", "country", "city", "status", "source",
    "lifetimeValue", "createdAt", "updatedAt", "lastContactAt",
  ],
  deals: [
    "title", "stage", "value", "currency", "probability",
    "expectedCloseDate", "actualCloseDate", "customerId",
    "ownerId", "createdAt", "updatedAt",
  ],
  quotes: [
    "quoteNumber", "title", "status", "total", "currency",
    "validUntil", "customerId", "issuedAt", "acceptedAt",
    "rejectedAt", "createdAt",
  ],
  contracts: [
    "contractNumber", "title", "status", "value", "currency",
    "startDate", "endDate", "signedAt", "customerId", "createdAt",
  ],
  tasks: [
    "title", "status", "priority", "dueDate",
    "assignedToId", "customerId", "dealId", "createdAt",
  ],
};

function sanitizeConditions(
  entityType: SearchEntityType,
  conditions: FilterCondition[]
): FilterCondition[] {
  const allowed = new Set(ALLOWED_FIELDS[entityType]);
  return conditions.filter((c) => allowed.has(c.field));
}

// ──────────────────────────────────────────────────────────────────────
// Execute advanced filter on a specific entity
// ──────────────────────────────────────────────────────────────────────
export async function advancedFilter(
  companyId: string,
  req: AdvancedFilterRequest
) {
  const safeConditions = sanitizeConditions(req.entityType, req.conditions);
  const where = buildWhereClause(companyId, safeConditions, req.logic || "AND");

  const page = Math.max(1, req.page || 1);
  const limit = Math.min(200, Math.max(1, req.limit || 50));
  const skip = (page - 1) * limit;

  const allowedSortFields = new Set(ALLOWED_FIELDS[req.entityType]);
  const sortBy =
    req.sortBy && allowedSortFields.has(req.sortBy) ? req.sortBy : "createdAt";
  const sortOrder = req.sortOrder === "asc" ? "asc" : "desc";
  const orderBy = { [sortBy]: sortOrder } as any;

  switch (req.entityType) {
    case "customers": {
      const [items, total] = await Promise.all([
        prisma.customer.findMany({
          where,
          include: { owner: { select: { id: true, fullName: true } } },
          orderBy,
          skip,
          take: limit,
        }),
        prisma.customer.count({ where }),
      ]);
      return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
    }
    case "deals": {
      const [items, total] = await Promise.all([
        prisma.deal.findMany({
          where,
          include: {
            customer: { select: { id: true, fullName: true } },
            owner: { select: { id: true, fullName: true } },
          },
          orderBy,
          skip,
          take: limit,
        }),
        prisma.deal.count({ where }),
      ]);
      return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
    }
    case "quotes": {
      const [items, total] = await Promise.all([
        prisma.quote.findMany({
          where,
          include: {
            customer: { select: { id: true, fullName: true } },
          },
          orderBy,
          skip,
          take: limit,
        }),
        prisma.quote.count({ where }),
      ]);
      return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
    }
    case "contracts": {
      const [items, total] = await Promise.all([
        prisma.contract.findMany({
          where,
          include: {
            customer: { select: { id: true, fullName: true } },
          },
          orderBy,
          skip,
          take: limit,
        }),
        prisma.contract.count({ where }),
      ]);
      return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
    }
    case "tasks": {
      const [items, total] = await Promise.all([
        prisma.task.findMany({
          where,
          include: {
            customer: { select: { id: true, fullName: true } },
            assignedTo: { select: { id: true, fullName: true } },
          },
          orderBy,
          skip,
          take: limit,
        }),
        prisma.task.count({ where }),
      ]);
      return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
    }
  }
}
