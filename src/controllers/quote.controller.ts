import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as QuoteSvc from "../services/quote.service";
import type { AuthenticatedRequest } from "../types";
import {
  recordAudit,
  extractRequestMeta,
  diffObjects,
} from "../utils/audit";

function audit(
  req: Request,
  action: string,
  entityId: string,
  before: unknown,
  after: unknown
) {
  const r = req as AuthenticatedRequest;
  recordAudit({
    userId: r.user.userId,
    companyId: r.user.companyId,
    action,
    entityType: "quote",
    entityId,
    before,
    after,
    changes:
      before && after
        ? diffObjects(
            before as unknown as Record<string, unknown>,
            after as unknown as Record<string, unknown>
          )
        : undefined,
    ...extractRequestMeta(req),
  }).catch(() => {});
}

// ============================================================================
// QUOTE CONTROLLER
// ============================================================================

const itemSchema = z.object({
  name: z.string().min(1).max(500),
  description: z.string().max(5000).optional().nullable(),
  quantity: z.coerce.number().min(0),
  unitPrice: z.coerce.number().min(0),
  discountPercent: z.coerce.number().min(0).max(100).optional(),
  taxPercent: z.coerce.number().min(0).max(100).optional(),
  position: z.coerce.number().int().optional(),
});

const createQuoteSchema = z.object({
  customerId: z.string().min(1),
  dealId: z.string().optional().nullable(),
  title: z.string().min(1).max(500),
  status: z
    .enum(["draft", "sent", "viewed", "accepted", "rejected", "expired"])
    .optional(),
  currency: z.string().min(2).max(8).optional(),
  issuedAt: z.coerce.date().optional().nullable(),
  validUntil: z.coerce.date().optional().nullable(),
  notes: z.string().max(10000).optional().nullable(),
  terms: z.string().max(10000).optional().nullable(),
  items: z.array(itemSchema).min(1),
});

const updateQuoteSchema = createQuoteSchema.partial();

const listQuotesSchema = z.object({
  page: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
  search: z.string().optional(),
  status: z
    .enum(["draft", "sent", "viewed", "accepted", "rejected", "expired"])
    .optional(),
  customerId: z.string().optional(),
  dealId: z.string().optional(),
  createdById: z.string().optional(),
  sortBy: z.enum(["createdAt", "validUntil", "total", "quoteNumber"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

export async function stats(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await QuoteSvc.getQuoteStats(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const q = listQuotesSchema.parse(req.query);
    const data = await QuoteSvc.listQuotes(companyId, q);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const dto = createQuoteSchema.parse(req.body);
    const data = await QuoteSvc.createQuote(
      companyId,
      userId,
      dto as QuoteSvc.CreateQuoteDto
    );
    audit(req, "quote.create", data.id, null, data);
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function getOne(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await QuoteSvc.getQuote(companyId, req.params.id as string);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const id = req.params.id as string;
    const dto = updateQuoteSchema.parse(req.body);
    const before = await QuoteSvc.getQuote(companyId, id).catch(() => null);
    const data = await QuoteSvc.updateQuote(
      companyId,
      id,
      dto as QuoteSvc.UpdateQuoteDto
    );
    audit(req, "quote.update", id, before, data);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function send(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const id = req.params.id as string;
    const before = await QuoteSvc.getQuote(companyId, id).catch(() => null);
    const data = await QuoteSvc.sendQuote(companyId, id);
    audit(req, "quote.send", id, before, data);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function accept(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const id = req.params.id as string;
    const before = await QuoteSvc.getQuote(companyId, id).catch(() => null);
    const data = await QuoteSvc.acceptQuote(companyId, id);
    audit(req, "quote.accept", id, before, data);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function reject(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const id = req.params.id as string;
    const before = await QuoteSvc.getQuote(companyId, id).catch(() => null);
    const data = await QuoteSvc.rejectQuote(companyId, id);
    audit(req, "quote.reject", id, before, data);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const id = req.params.id as string;
    const before = await QuoteSvc.getQuote(companyId, id).catch(() => null);
    const data = await QuoteSvc.deleteQuote(companyId, id);
    audit(req, "quote.delete", id, before, null);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// Public (no auth) — for customer to view quote via token
export async function publicView(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const token = req.params.token as string;
    const data = await QuoteSvc.getQuoteByPublicToken(token);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
