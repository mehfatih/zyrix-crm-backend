import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import {
  issueTaxInvoice,
  listTaxInvoices,
  getTaxInvoice,
  markSubmitted,
  markApproved,
  markRejected,
} from "../services/tax-invoices.service";
import { recordAudit, extractRequestMeta } from "../utils/audit";

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const { items, total } = await listTaxInvoices(companyId, {
      regime: req.query.regime as any,
      status: req.query.status as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    });
    res.status(200).json({ success: true, data: { items, total } });
  } catch (err) {
    next(err);
  }
}

export async function detail(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await getTaxInvoice(companyId, req.params.id as string);
    if (!data) {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "TaxInvoice not found" },
      });
    }
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

const lineItemSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: z.number().positive(),
  unitPrice: z.number().nonnegative(),
  discount: z.number().nonnegative().optional(),
  taxRate: z.number().min(0).max(100).optional(),
  lineTotal: z.number().nonnegative(),
});

const issueSchema = z.object({
  regime: z.enum(["zatca", "efatura", "earsiv"]),
  type: z.enum(["standard", "simplified", "credit_note", "debit_note"]).optional(),
  quoteId: z.string().uuid().optional(),
  contractId: z.string().uuid().optional(),
  dealId: z.string().uuid().optional(),
  sellerName: z.string().min(1).max(200),
  sellerVatNo: z.string().max(50).optional(),
  sellerAddress: z.string().max(500).optional(),
  buyerName: z.string().min(1).max(200),
  buyerVatNo: z.string().max(50).optional(),
  buyerAddress: z.string().max(500).optional(),
  currency: z.string().length(3).optional(),
  taxRate: z.number().min(0).max(100),
  discountAmount: z.number().nonnegative().optional(),
  lineItems: z.array(lineItemSchema).min(1),
});

export async function issue(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, companyId } = auth(req);
    const dto = issueSchema.parse(req.body) as any;
    const data = await issueTaxInvoice(companyId, dto);
    await recordAudit({
      userId,
      companyId,
      action: "tax_invoice.issued",
      entityType: "tax_invoice",
      entityId: data.id,
      after: data,
      metadata: {
        regime: data.regime,
        invoiceNumber: data.invoiceNumber,
        totalAmount: data.totalAmount,
      },
      ...extractRequestMeta(req),
    });
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// Raw XML download — sets text/xml content type
export async function downloadXml(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const inv = await getTaxInvoice(companyId, req.params.id as string);
    if (!inv || !inv.xml) {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Invoice or XML not found" },
      });
    }
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="invoice-${inv.invoiceNumber}.xml"`
    );
    res.status(200).send(inv.xml);
  } catch (err) {
    next(err);
  }
}

const submitSchema = z.object({ externalId: z.string().min(1).max(200) });

export async function submit(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, companyId } = auth(req);
    const { externalId } = submitSchema.parse(req.body);
    const id = req.params.id as string;
    const before = await getTaxInvoice(companyId, id).catch(() => null);
    const data = await markSubmitted(companyId, id, externalId);
    await recordAudit({
      userId,
      companyId,
      action: "tax_invoice.submitted",
      entityType: "tax_invoice",
      entityId: data.id,
      before,
      after: data,
      metadata: { externalId },
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function approve(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, companyId } = auth(req);
    const id = req.params.id as string;
    const before = await getTaxInvoice(companyId, id).catch(() => null);
    const data = await markApproved(companyId, id);
    await recordAudit({
      userId,
      companyId,
      action: "tax_invoice.approved",
      entityType: "tax_invoice",
      entityId: data.id,
      before,
      after: data,
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

const rejectSchema = z.object({ reason: z.string().min(1).max(500) });

export async function reject(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, companyId } = auth(req);
    const { reason } = rejectSchema.parse(req.body);
    const id = req.params.id as string;
    const before = await getTaxInvoice(companyId, id).catch(() => null);
    const data = await markRejected(companyId, id, reason);
    await recordAudit({
      userId,
      companyId,
      action: "tax_invoice.rejected",
      entityType: "tax_invoice",
      entityId: data.id,
      before,
      after: data,
      metadata: { reason },
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
