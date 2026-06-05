import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as Catalog from "../services/cpq-catalog.service";
import type { AuthenticatedRequest } from "../types";

// ============================================================================
// CPQ CATALOG CONTROLLER — price books, discount rules, bundles (Sprint 9)
// ============================================================================

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

const segmentSchema = z
  .object({
    tags: z.array(z.string()).optional(),
    countries: z.array(z.string()).optional(),
  })
  .nullable();

const priceBookSchema = z.object({
  name: z.string().min(1).max(200),
  currency: z.string().min(2).max(8).optional(),
  isDefault: z.boolean().optional(),
  segmentRules: segmentSchema.optional(),
});

const entrySchema = z.object({
  productId: z.string().min(1),
  price: z.coerce.number().min(0),
});

const discountRuleSchema = z.object({
  scope: z.enum(["role", "user"]).optional(),
  scopeValue: z.string().min(1).max(200),
  maxPct: z.coerce.number().min(0).max(100),
  approvalAbovePct: z.coerce.number().min(0).max(100).optional().nullable(),
});

const bundleItemSchema = z.object({
  productId: z.string().min(1),
  qty: z.coerce.number().min(0),
});

const bundleSchema = z.object({
  name: z.string().min(1).max(200),
  items: z.array(bundleItemSchema).min(1),
  bundlePrice: z.coerce.number().min(0),
  status: z.enum(["active", "archived"]).optional(),
});

// ── Price books ──────────────────────────────────────────────────────────────
export async function listPriceBooks(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await Catalog.listPriceBooks(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function getPriceBook(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await Catalog.getPriceBook(companyId, req.params.id as string);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function createPriceBook(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = priceBookSchema.parse(req.body);
    const data = await Catalog.createPriceBook(companyId, dto as Catalog.PriceBookDto);
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function updatePriceBook(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = priceBookSchema.partial().parse(req.body);
    const data = await Catalog.updatePriceBook(companyId, req.params.id as string, dto);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function deletePriceBook(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await Catalog.deletePriceBook(companyId, req.params.id as string);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function setEntry(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = entrySchema.parse(req.body);
    const data = await Catalog.setEntry(
      companyId,
      req.params.id as string,
      dto as Catalog.PriceBookEntryDto
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function deleteEntry(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await Catalog.deleteEntry(
      companyId,
      req.params.id as string,
      req.params.productId as string
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ── Discount rules ─────────────────────────────────────────────────────────
export async function listDiscountRules(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await Catalog.listDiscountRules(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function createDiscountRule(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = discountRuleSchema.parse(req.body);
    const data = await Catalog.createDiscountRule(companyId, dto as Catalog.DiscountRuleDto);
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function updateDiscountRule(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = discountRuleSchema.partial().parse(req.body);
    const data = await Catalog.updateDiscountRule(companyId, req.params.id as string, dto);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function deleteDiscountRule(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await Catalog.deleteDiscountRule(companyId, req.params.id as string);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ── Bundles ──────────────────────────────────────────────────────────────────
export async function listBundles(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const includeArchived = req.query.includeArchived === "true";
    const data = await Catalog.listBundles(companyId, includeArchived);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function getBundle(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await Catalog.getBundle(companyId, req.params.id as string);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function createBundle(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = bundleSchema.parse(req.body);
    const data = await Catalog.createBundle(companyId, dto as Catalog.BundleDto);
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function updateBundle(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = bundleSchema.partial().parse(req.body);
    const data = await Catalog.updateBundle(
      companyId,
      req.params.id as string,
      dto as Partial<Catalog.BundleDto>
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function deleteBundle(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await Catalog.deleteBundle(companyId, req.params.id as string);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
