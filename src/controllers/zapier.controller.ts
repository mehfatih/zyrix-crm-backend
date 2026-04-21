import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import * as customerService from "../services/customer.service";
import * as dealService from "../services/deal.service";
import * as activityService from "../services/activity.service";
import { prisma } from "../config/database";

// ============================================================================
// ZAPIER INTEGRATION ENDPOINTS
// ----------------------------------------------------------------------------
// Zapier's platform is opinionated about response shapes:
//   • Triggers: return a FLAT ARRAY of objects (no envelope). Zapier
//     deduplicates by `id` field internally.
//   • Actions: return a single flat object (the created resource).
//   • Search actions: also a flat array.
//
// Triggers are polled every 1-15 minutes. To keep runs cheap and
// deterministic, they return the most recent 50 matching records sorted
// by creation time DESC. Zapier handles new-vs-seen dedup on its side.
//
// We don't use the `since` filter here because Zapier's model is:
//   1. On first setup: take newest 50, mark all as "seen"
//   2. On each poll: fetch newest 50, diff against seen set, deliver new
// Our job is just to return fresh data reliably.
// ============================================================================

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

// ──────────────────────────────────────────────────────────────────────
// SHARED SERIALIZERS — flat, Zapier-friendly (primitives + nested refs)
// ──────────────────────────────────────────────────────────────────────
// Zapier renders response fields as a flat tree in its UI; deep nesting
// is fine but ALL leaf values must be serializable primitives. We add
// a `zapierPrimaryKey` alias for the `id` field just in case the Zapier
// template config references it differently (belt-and-braces).

function zapCustomer(c: any) {
  return {
    id: c.id,
    fullName: c.fullName,
    firstName: (c.fullName ?? "").split(" ")[0] ?? "",
    email: c.email ?? "",
    phone: c.phone ?? "",
    whatsappPhone: c.whatsappPhone ?? c.phone ?? "",
    companyName: c.companyName ?? "",
    position: c.position ?? "",
    country: c.country ?? "",
    city: c.city ?? "",
    status: c.status,
    source: c.source ?? "",
    notes: c.notes ?? "",
    lifetimeValue: Number(c.lifetimeValue ?? 0),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function zapDeal(d: any) {
  return {
    id: d.id,
    title: d.title,
    customerId: d.customerId,
    customerName: d.customer?.fullName ?? "",
    customerEmail: d.customer?.email ?? "",
    customerPhone: d.customer?.phone ?? "",
    customerCompany: d.customer?.companyName ?? "",
    value: Number(d.value ?? 0),
    currency: d.currency,
    stage: d.stage,
    probability: d.probability,
    expectedCloseDate: d.expectedCloseDate ?? null,
    actualCloseDate: d.actualCloseDate ?? null,
    description: d.description ?? "",
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

// ──────────────────────────────────────────────────────────────────────
// TRIGGER: new_customer
// ──────────────────────────────────────────────────────────────────────

export async function triggerNewCustomer(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    // Fetch newest 50 customers — Zapier dedupes on `id`.
    const customers = await prisma.customer.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    // Flat array, no envelope — Zapier spec.
    res.status(200).json(customers.map(zapCustomer));
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// TRIGGER: customer_status_changed — latest customer status changes
// ──────────────────────────────────────────────────────────────────────
// We don't have an audit of status transitions on customers in the
// schema, so this trigger fires on any customer whose updatedAt is
// recent (i.e. recently modified). Zapier users can further filter
// with their built-in conditional steps.
// ──────────────────────────────────────────────────────────────────────

export async function triggerCustomerUpdated(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const customers = await prisma.customer.findMany({
      where: { companyId },
      orderBy: { updatedAt: "desc" },
      take: 50,
    });
    res.status(200).json(customers.map(zapCustomer));
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// TRIGGER: new_deal
// ──────────────────────────────────────────────────────────────────────

export async function triggerNewDeal(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const deals = await prisma.deal.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        customer: {
          select: { id: true, fullName: true, email: true, phone: true, companyName: true },
        },
      },
    });
    res.status(200).json(deals.map(zapDeal));
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// TRIGGER: deal_won — filters stage='won'
// ──────────────────────────────────────────────────────────────────────

export async function triggerDealWon(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const deals = await prisma.deal.findMany({
      where: { companyId, stage: "won" },
      orderBy: { updatedAt: "desc" },
      take: 50,
      include: {
        customer: {
          select: { id: true, fullName: true, email: true, phone: true, companyName: true },
        },
      },
    });
    res.status(200).json(deals.map(zapDeal));
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// TRIGGER: deal_lost — filters stage='lost'
// ──────────────────────────────────────────────────────────────────────

export async function triggerDealLost(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const deals = await prisma.deal.findMany({
      where: { companyId, stage: "lost" },
      orderBy: { updatedAt: "desc" },
      take: 50,
      include: {
        customer: {
          select: { id: true, fullName: true, email: true, phone: true, companyName: true },
        },
      },
    });
    res.status(200).json(deals.map(zapDeal));
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// ACTION: create_customer
// Zapier actions return a single flat object (the created resource)
// ──────────────────────────────────────────────────────────────────────

const zapCreateCustomerSchema = z.object({
  fullName: z.string().min(1).max(200),
  email: z.string().email().optional(),
  phone: z.string().max(30).optional(),
  whatsappPhone: z.string().max(30).optional(),
  companyName: z.string().max(200).optional(),
  position: z.string().max(100).optional(),
  country: z.string().max(100).optional(),
  city: z.string().max(100).optional(),
  source: z.string().max(50).optional(),
  status: z.string().max(50).optional(),
  notes: z.string().max(2000).optional(),
});

export async function actionCreateCustomer(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const dto = zapCreateCustomerSchema.parse(req.body) as any;
    // Zapier's default Zap source = 'zapier' so users can report on
    // Zap-originated customers from the analytics side.
    const customer = await customerService.createCustomer(companyId, userId, {
      ...dto,
      source: dto.source || "zapier",
    });
    res.status(200).json(zapCustomer(customer));
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// ACTION: find_customer — search by email or phone
// Returns an array (empty or single-element) per Zapier 'search' spec.
// ──────────────────────────────────────────────────────────────────────

const findCustomerSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().optional(),
});

export async function actionFindCustomer(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const q = findCustomerSchema.parse(req.query);
    if (!q.email && !q.phone) {
      return res.status(400).json({
        error: "Provide email or phone to search",
      });
    }
    const customer = await prisma.customer.findFirst({
      where: {
        companyId,
        OR: [
          q.email ? { email: q.email.toLowerCase() } : undefined,
          q.phone ? { phone: q.phone } : undefined,
        ].filter(Boolean) as any,
      },
    });
    // Zapier search convention: array, possibly empty
    res.status(200).json(customer ? [zapCustomer(customer)] : []);
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// ACTION: create_deal
// ──────────────────────────────────────────────────────────────────────

const zapCreateDealSchema = z.object({
  title: z.string().min(1).max(200),
  customerId: z.string().uuid(),
  value: z.coerce.number().nonnegative().optional(),
  currency: z.string().max(10).optional(),
  stage: z.string().max(50).optional(),
  probability: z.coerce.number().min(0).max(100).optional(),
  description: z.string().max(2000).optional(),
});

export async function actionCreateDeal(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const dto = zapCreateDealSchema.parse(req.body) as any;
    const deal = await dealService.createDeal(companyId, userId, dto);
    res.status(200).json(zapDeal(deal));
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// ACTION: update_deal_stage
// ──────────────────────────────────────────────────────────────────────

const updateStageSchema = z.object({
  dealId: z.string().uuid(),
  stage: z.string().min(1).max(50),
});

export async function actionUpdateDealStage(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const { dealId, stage } = updateStageSchema.parse(req.body);
    const deal = await dealService.updateDeal(companyId, dealId, {
      stage,
    } as any);
    res.status(200).json(zapDeal(deal));
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// ACTION: create_task
// ──────────────────────────────────────────────────────────────────────

const zapCreateTaskSchema = z.object({
  title: z.string().min(1).max(200),
  customerId: z.string().uuid().optional(),
  dealId: z.string().uuid().optional(),
  dueDate: z.string().datetime().optional(),
  content: z.string().max(5000).optional(),
});

export async function actionCreateTask(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const dto = zapCreateTaskSchema.parse(req.body);
    const activity = await activityService.createActivity(companyId, userId, {
      type: "task",
      title: dto.title,
      content: dto.content,
      customerId: dto.customerId,
      dealId: dto.dealId,
      dueDate: dto.dueDate,
    } as any);
    res.status(200).json({
      id: activity.id,
      title: activity.title,
      type: activity.type,
      customerId: activity.customerId ?? "",
      dealId: activity.dealId ?? "",
      dueDate: activity.dueDate ?? null,
      createdAt: activity.createdAt,
    });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// AUTH TEST (Zapier uses this to validate credentials on connect)
// ──────────────────────────────────────────────────────────────────────

export async function zapierAuthTest(req: Request, res: Response) {
  const { companyId, userId } = auth(req);
  // Zapier shows this as the 'connection label' in the UI, so return
  // something humans can eyeball. We return the company ID + user ID
  // since API keys act on behalf of their creator.
  res.status(200).json({
    companyId,
    userId,
    label: `Zyrix CRM (${companyId.slice(0, 8)})`,
    status: "connected",
  });
}

// ──────────────────────────────────────────────────────────────────────
// DYNAMIC DROPDOWNS for Zapier UI
// ──────────────────────────────────────────────────────────────────────
// When a user sets up a Zap like "When X → create deal for customer Y",
// Zapier needs to populate a dropdown of the user's customers. We expose
// lightweight endpoints that return { id, name } pairs so Zapier's UI
// can render selectable options without pulling the full customer objects.

export async function dropdownCustomers(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const customers = await prisma.customer.findMany({
      where: { companyId },
      select: {
        id: true,
        fullName: true,
        companyName: true,
        email: true,
      },
      orderBy: { fullName: "asc" },
      take: 500,
    });
    // Zapier dynamic dropdown format: array of { id, name }
    res.status(200).json(
      customers.map((c) => ({
        id: c.id,
        name: c.companyName
          ? `${c.fullName} — ${c.companyName}`
          : c.fullName,
        email: c.email ?? "",
      }))
    );
  } catch (err) {
    next(err);
  }
}

export async function dropdownPipelineStages(
  _req: Request,
  res: Response
) {
  // Static for MVP — same stages as VALID_STAGES in deal.service
  res.status(200).json([
    { id: "lead", name: "Lead" },
    { id: "qualified", name: "Qualified" },
    { id: "proposal", name: "Proposal" },
    { id: "negotiation", name: "Negotiation" },
    { id: "won", name: "Won" },
    { id: "lost", name: "Lost" },
  ]);
}
