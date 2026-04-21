import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import * as customerService from "../services/customer.service";
import * as dealService from "../services/deal.service";
import * as activityService from "../services/activity.service";

// ============================================================================
// PUBLIC API v1 CONTROLLERS
// ----------------------------------------------------------------------------
// These are the endpoints consumed by Zapier and third-party integrations.
// They wrap the existing services but shape the response for external
// consumers:
//   • consistent { data, pagination?, next? } envelope
//   • camelCase fields only (no internal Decimal wrapping, no _count blocks)
//   • HATEOAS-lite — include the resource URL in the response for clients
//     that want to navigate
//
// Authentication is handled by authenticateApiKeyMiddleware upstream so
// req.user is always present here.
// ============================================================================

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

function serializeCustomer(c: any) {
  return {
    id: c.id,
    fullName: c.fullName,
    email: c.email,
    phone: c.phone,
    whatsappPhone: c.whatsappPhone,
    companyName: c.companyName,
    position: c.position,
    country: c.country,
    city: c.city,
    address: c.address,
    status: c.status,
    source: c.source,
    notes: c.notes,
    lifetimeValue: Number(c.lifetimeValue ?? 0),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function serializeDeal(d: any) {
  return {
    id: d.id,
    title: d.title,
    customerId: d.customerId,
    customer: d.customer
      ? {
          id: d.customer.id,
          fullName: d.customer.fullName,
          companyName: d.customer.companyName ?? null,
        }
      : null,
    value: Number(d.value ?? 0),
    currency: d.currency,
    stage: d.stage,
    probability: d.probability,
    expectedCloseDate: d.expectedCloseDate,
    actualCloseDate: d.actualCloseDate,
    description: d.description,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

// ──────────────────────────────────────────────────────────────────────
// CUSTOMERS
// ──────────────────────────────────────────────────────────────────────

const listCustomersSchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  search: z.string().optional(),
  status: z.string().optional(),
  since: z.string().datetime().optional(), // ISO timestamp — for Zapier polling
});

export async function listCustomersV1(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const q = listCustomersSchema.parse(req.query);
    const result = await customerService.listCustomers(companyId, {
      page: q.page,
      limit: q.limit,
      search: q.search,
      status: q.status,
    });
    let items = (result as any).customers ?? [];
    // `since` filter applied post-query — Zapier uses it to fetch only
    // new customers since its last poll.
    if (q.since) {
      const sinceDate = new Date(q.since);
      items = items.filter(
        (c: any) => new Date(c.createdAt) > sinceDate
      );
    }
    res.status(200).json({
      data: items.map(serializeCustomer),
      pagination: (result as any).pagination ?? {
        page: 1,
        total: items.length,
        limit: items.length,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function getCustomerV1(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const customer = await customerService.getCustomerById(
      companyId,
      req.params.id as string
    );
    res.status(200).json({ data: serializeCustomer(customer) });
  } catch (err) {
    next(err);
  }
}

const createCustomerSchema = z.object({
  fullName: z.string().min(1).max(200),
  email: z.string().email().optional(),
  phone: z.string().max(30).optional(),
  whatsappPhone: z.string().max(30).optional(),
  companyName: z.string().max(200).optional(),
  position: z.string().max(100).optional(),
  country: z.string().max(100).optional(),
  city: z.string().max(100).optional(),
  address: z.string().max(500).optional(),
  source: z.string().max(50).optional(),
  status: z.string().max(50).optional(),
  notes: z.string().max(2000).optional(),
});

export async function createCustomerV1(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const dto = createCustomerSchema.parse(req.body);
    const customer = await customerService.createCustomer(companyId, userId, dto as any);
    res.status(201).json({ data: serializeCustomer(customer) });
  } catch (err) {
    next(err);
  }
}

const updateCustomerSchema = createCustomerSchema.partial();

export async function updateCustomerV1(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const dto = updateCustomerSchema.parse(req.body);
    const customer = await customerService.updateCustomer(
      companyId,
      req.params.id as string,
      dto
    );
    res.status(200).json({ data: serializeCustomer(customer) });
  } catch (err) {
    next(err);
  }
}

export async function deleteCustomerV1(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    await customerService.deleteCustomer(companyId, req.params.id as string);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// DEALS
// ──────────────────────────────────────────────────────────────────────

const listDealsSchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  stage: z.string().optional(),
  customerId: z.string().optional(),
  since: z.string().datetime().optional(),
});

export async function listDealsV1(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const q = listDealsSchema.parse(req.query);
    const result = await dealService.listDeals(companyId, {
      page: q.page,
      limit: q.limit,
      stage: q.stage,
      customerId: q.customerId,
    });
    let items = (result as any).deals ?? [];
    if (q.since) {
      const sinceDate = new Date(q.since);
      items = items.filter((d: any) => new Date(d.updatedAt) > sinceDate);
    }
    res.status(200).json({
      data: items.map(serializeDeal),
      pagination: (result as any).pagination ?? {
        page: 1,
        total: items.length,
        limit: items.length,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function getDealV1(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const deal = await dealService.getDealById(
      companyId,
      req.params.id as string
    );
    res.status(200).json({ data: serializeDeal(deal) });
  } catch (err) {
    next(err);
  }
}

const createDealSchema = z.object({
  title: z.string().min(1).max(200),
  customerId: z.string().uuid(),
  value: z.number().nonnegative().optional(),
  currency: z.string().max(10).optional(),
  stage: z.string().max(50).optional(),
  probability: z.number().min(0).max(100).optional(),
  expectedCloseDate: z.string().datetime().optional(),
  description: z.string().max(2000).optional(),
});

export async function createDealV1(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const dto = createDealSchema.parse(req.body);
    const deal = await dealService.createDeal(companyId, userId, dto as any);
    res.status(201).json({ data: serializeDeal(deal) });
  } catch (err) {
    next(err);
  }
}

const updateDealSchema = createDealSchema
  .partial()
  .extend({
    actualCloseDate: z.string().datetime().nullable().optional(),
    lostReason: z.string().max(500).optional(),
  });

export async function updateDealV1(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const dto = updateDealSchema.parse(req.body);
    const deal = await dealService.updateDeal(
      companyId,
      req.params.id as string,
      dto as any
    );
    res.status(200).json({ data: serializeDeal(deal) });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// ACTIVITIES (create-only for external systems)
// ──────────────────────────────────────────────────────────────────────

const createActivitySchema = z.object({
  type: z.enum(["note", "call", "email", "meeting", "task", "whatsapp"]),
  title: z.string().min(1).max(200),
  content: z.string().max(5000).optional(),
  customerId: z.string().uuid().optional(),
  dealId: z.string().uuid().optional(),
  dueDate: z.string().datetime().optional(),
});

export async function createActivityV1(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const dto = createActivitySchema.parse(req.body);
    const activity = await activityService.createActivity(companyId, userId, dto as any);
    res.status(201).json({
      data: {
        id: activity.id,
        type: activity.type,
        title: activity.title,
        content: activity.content,
        customerId: activity.customerId,
        dealId: activity.dealId,
        dueDate: activity.dueDate,
        completedAt: activity.completedAt,
        createdAt: activity.createdAt,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// AUTH TEST — Zapier uses this on connection setup to verify the key
// ──────────────────────────────────────────────────────────────────────

export async function authTest(req: Request, res: Response) {
  const { companyId } = auth(req);
  res.status(200).json({
    data: {
      authenticated: true,
      companyId,
      apiVersion: "v1",
    },
  });
}
