import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as ReportsSvc from "../services/reports.service";
import type { AuthenticatedRequest } from "../types";

const rateSchema = z.object({
  fromCurrency: z.string().min(2).max(8),
  toCurrency: z.string().min(2).max(8),
  rate: z.coerce.number().positive(),
});

const baseCurrencySchema = z.object({
  baseCurrency: z.string().min(2).max(8).optional(),
  since: z.coerce.date().optional(),
});

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

// Rates
export async function listRates(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await ReportsSvc.listRates(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function upsertRate(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const dto = rateSchema.parse(req.body);
    const data = await ReportsSvc.upsertRate(
      companyId,
      dto as ReportsSvc.ExchangeRateDto
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function deleteRate(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await ReportsSvc.deleteRate(
      companyId,
      req.params.id as string
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// Reports
export async function revenue(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const q = baseCurrencySchema.parse(req.query);
    const data = await ReportsSvc.getRevenueReport(
      companyId,
      q.baseCurrency,
      q.since
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function pipeline(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const q = baseCurrencySchema.parse(req.query);
    const data = await ReportsSvc.getPipelineReport(
      companyId,
      q.baseCurrency
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function summary(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const q = baseCurrencySchema.parse(req.query);
    const data = await ReportsSvc.getFinancialSummary(
      companyId,
      q.baseCurrency
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

const ecommerceSchema = z.object({
  baseCurrency: z.string().min(2).max(8).optional(),
  windowDays: z.coerce.number().int().positive().max(365).optional(),
});

export async function ecommerce(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const q = ecommerceSchema.parse(req.query);
    const data = await ReportsSvc.getEcommerceAnalytics(
      companyId,
      q.baseCurrency,
      q.windowDays
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ============================================================================
// E-COMMERCE ANALYTICS — EXPORT (CSV / PDF)
// ============================================================================
import {
  buildAnalyticsCsv,
  buildAnalyticsPdf,
} from "../services/ecommerceExport.service";

const ecommerceExportSchema = z.object({
  format: z.enum(["csv", "pdf"]),
  baseCurrency: z.string().min(2).max(8).optional(),
  windowDays: z.coerce.number().int().positive().max(365).optional(),
});

export async function ecommerceExport(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const q = ecommerceExportSchema.parse(req.query);
    const analytics = await ReportsSvc.getEcommerceAnalytics(
      companyId,
      q.baseCurrency,
      q.windowDays
    );

    // Filename includes the window + generated-at date so re-exports don't
    // collide in the user's Downloads folder.
    const stamp = new Date().toISOString().slice(0, 10);
    const baseName = `zyrix-ecommerce-${q.windowDays || 30}d-${stamp}`;

    if (q.format === "csv") {
      const csv = buildAnalyticsCsv(analytics);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${baseName}.csv"`
      );
      res.status(200).send(csv);
      return;
    }

    // format === 'pdf'
    const buf = await buildAnalyticsPdf(analytics);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${baseName}.pdf"`
    );
    res.setHeader("Content-Length", buf.length.toString());
    res.status(200).send(buf);
  } catch (err) {
    next(err);
  }
}

// ============================================================================
// COHORT + FUNNEL
// ============================================================================
import {
  getCohortReport,
  getFunnelReport,
} from "../services/analytics-advanced.service";

const cohortQuerySchema = z.object({
  monthsBack: z.coerce.number().int().positive().max(24).optional(),
});

export async function cohort(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const q = cohortQuerySchema.parse(req.query);
    const data = await getCohortReport(companyId, q.monthsBack);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

const funnelQuerySchema = z.object({
  windowDays: z.coerce.number().int().positive().max(365).optional(),
});

export async function funnel(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const q = funnelQuerySchema.parse(req.query);
    const data = await getFunnelReport(companyId, q.windowDays);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
