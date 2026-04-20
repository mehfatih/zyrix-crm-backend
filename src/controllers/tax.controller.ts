import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as TaxSvc from "../services/tax.service";
import type { AuthenticatedRequest } from "../types";

const createTaxSchema = z.object({
  name: z.string().min(1).max(200),
  code: z.string().max(50).optional(),
  countryCode: z.string().length(2).optional(),
  ratePercent: z.coerce.number().min(0).max(100),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  description: z.string().max(2000).optional(),
});

const updateTaxSchema = createTaxSchema.partial();

const listQuerySchema = z.object({
  countryCode: z.string().optional(),
  activeOnly: z.coerce.boolean().optional(),
});

const seedSchema = z.object({
  countryCode: z.string().length(2),
});

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const q = listQuerySchema.parse(req.query);
    const data = await TaxSvc.listTaxRates(companyId, q);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function getOne(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await TaxSvc.getTaxRate(companyId, req.params.id as string);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = createTaxSchema.parse(req.body);
    const data = await TaxSvc.createTaxRate(
      companyId,
      dto as TaxSvc.CreateTaxRateDto
    );
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = updateTaxSchema.parse(req.body);
    const data = await TaxSvc.updateTaxRate(
      companyId,
      req.params.id as string,
      dto as TaxSvc.UpdateTaxRateDto
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await TaxSvc.deleteTaxRate(
      companyId,
      req.params.id as string
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function presets(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const data = TaxSvc.availablePresets();
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function seedPresets(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const dto = seedSchema.parse(req.body);
    const data = await TaxSvc.seedPresets(companyId, dto.countryCode);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
