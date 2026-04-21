import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as EmailTemplatesSvc from "../services/emailTemplate.service";
import * as CustomFieldsSvc from "../services/customField.service";
import * as BulkActionsSvc from "../services/bulkAction.service";
import * as ExportSvc from "../services/export.service";
import * as ImportSvc from "../services/import.service";
import * as TimelineSvc from "../services/timeline.service";
import * as ShopifySvc from "../services/shopify.service";
import * as EcommerceSvc from "../services/ecommerce.service";
import * as SearchSvc from "../services/search.service";
import type { AuthenticatedRequest } from "../types";

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

// ============================================================================
// EMAIL TEMPLATES
// ============================================================================
const templateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  category: z.string().max(50).optional(),
  subject: z.string().min(1).max(300),
  bodyHtml: z.string().min(1).max(100000),
  bodyText: z.string().max(50000).optional(),
  variables: z.array(z.string()).optional(),
  isShared: z.boolean().optional(),
});

export async function listTemplates(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const category = req.query.category as string | undefined;
    const data = await EmailTemplatesSvc.listTemplates(companyId, userId, category);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}
export async function getTemplate(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const data = await EmailTemplatesSvc.getTemplate(companyId, userId, req.params.id as string);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}
export async function createTemplate(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const dto = templateSchema.parse(req.body);
    const data = await EmailTemplatesSvc.createTemplate(companyId, userId, dto as EmailTemplatesSvc.CreateTemplateDto);
    res.status(201).json({ success: true, data });
  } catch (err) { next(err); }
}
export async function updateTemplate(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const dto = templateSchema.partial().parse(req.body);
    const data = await EmailTemplatesSvc.updateTemplate(
      companyId,
      userId,
      req.params.id as string,
      dto as EmailTemplatesSvc.UpdateTemplateDto
    );
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}
export async function deleteTemplate(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const data = await EmailTemplatesSvc.deleteTemplate(companyId, userId, req.params.id as string);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

// ============================================================================
// CUSTOM FIELDS
// ============================================================================
const fieldSchema = z.object({
  entityType: z.enum(["customer", "deal"]),
  fieldKey: z.string().min(1).max(50),
  label: z.string().min(1).max(100),
  fieldType: z.enum(["text", "number", "date", "select", "multi_select", "boolean", "url", "email"]),
  options: z.array(z.string()).optional(),
  required: z.boolean().optional(),
  defaultValue: z.string().max(500).optional(),
  position: z.number().int().optional(),
});

export async function listFields(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const entityType = req.query.entityType as "customer" | "deal" | undefined;
    const data = await CustomFieldsSvc.listFields(companyId, entityType);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}
export async function createField(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = fieldSchema.parse(req.body);
    const data = await CustomFieldsSvc.createField(companyId, dto as CustomFieldsSvc.CreateFieldDto);
    res.status(201).json({ success: true, data });
  } catch (err) { next(err); }
}
export async function updateField(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = fieldSchema.partial().extend({ isActive: z.boolean().optional() }).parse(req.body);
    const data = await CustomFieldsSvc.updateField(companyId, req.params.id as string, dto);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}
export async function deleteField(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await CustomFieldsSvc.deleteField(companyId, req.params.id as string);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

// ============================================================================
// BULK ACTIONS
// ============================================================================
const bulkSchema = z.object({
  entityType: z.enum(["customers", "deals"]),
  action: z.enum(["delete", "assignOwner", "changeStatus", "addTag", "removeTag", "changeStage"]),
  ids: z.array(z.string()).min(1).max(500),
  params: z.object({
    ownerId: z.string().optional(),
    status: z.string().optional(),
    stage: z.string().optional(),
    tagId: z.string().optional(),
  }).optional(),
});

export async function bulkAction(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = bulkSchema.parse(req.body);
    const data = await BulkActionsSvc.bulkAction(companyId, dto as BulkActionsSvc.BulkActionDto);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

// ============================================================================
// IMPORT (CSV)
// ============================================================================
const importSchema = z.object({
  csvText: z.string().min(1),
  ownerId: z.string().optional(),
  skipDuplicates: z.boolean().optional(),
});

export async function importCustomers(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = importSchema.parse(req.body);
    const result = await ImportSvc.importCustomers(companyId, dto.csvText, {
      ownerId: dto.ownerId,
      skipDuplicates: dto.skipDuplicates,
    });
    res.status(200).json({ success: true, data: result });
  } catch (err) { next(err); }
}

// ============================================================================
// EXPORT
// ============================================================================
const exportSchema = z.object({
  entityType: z.enum(["customers", "deals", "quotes", "contracts", "commissions"]),
  format: z.enum(["csv", "xlsx", "pdf"]),
  filters: z.record(z.any()).optional(),
  columns: z.array(z.string()).optional(),
});

export async function exportData(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = exportSchema.parse(req.body);
    const out = await ExportSvc.exportData(companyId, dto as ExportSvc.ExportOptions);
    res.setHeader("Content-Type", out.mimeType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${out.filename}"`
    );
    if (Buffer.isBuffer(out.content)) {
      res.status(200).send(out.content);
    } else {
      res.status(200).send(out.content);
    }
  } catch (err) { next(err); }
}

// ============================================================================
// TIMELINE
// ============================================================================
const timelineSchema = z.object({
  types: z.array(z.string()).optional(),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export async function getCustomerTimeline(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const customerId = req.params.customerId as string;
    const q = timelineSchema.parse(req.query);
    const data = await TimelineSvc.getCustomerTimeline(companyId, customerId, {
      types: q.types as any,
      since: q.since,
      until: q.until,
      limit: q.limit,
    });
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

// ============================================================================
// SHOPIFY
// ============================================================================
const shopifyConnectSchema = z.object({
  shopDomain: z.string().min(3).max(200),
  accessToken: z.string().min(10).max(200),
});

export async function shopifyListStores(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await ShopifySvc.listStores(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}
export async function shopifyConnect(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = shopifyConnectSchema.parse(req.body);
    const data = await ShopifySvc.connectStore(companyId, dto as ShopifySvc.ConnectStoreDto);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}
export async function shopifyDisconnect(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await ShopifySvc.disconnectStore(companyId, req.params.id as string);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}
export async function shopifySync(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await ShopifySvc.syncStore(companyId, req.params.id as string);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

// ============================================================================
// ADVANCED SEARCH
// ============================================================================
const globalSearchSchema = z.object({
  q: z.string().min(1).max(200),
});

export async function globalSearch(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const { q } = globalSearchSchema.parse(req.query);
    const data = await SearchSvc.globalSearch(companyId, q);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

const filterConditionSchema = z.object({
  field: z.string().min(1).max(80),
  operator: z.enum([
    "equals", "contains", "starts_with", "not_equals",
    "greater_than", "less_than", "greater_or_equal", "less_or_equal",
    "in", "not_in", "is_empty", "is_not_empty", "between",
  ]),
  value: z.any().optional(),
  value2: z.any().optional(),
});

const advancedFilterSchema = z.object({
  entityType: z.enum(["customers", "deals", "quotes", "contracts", "tasks"]),
  conditions: z.array(filterConditionSchema).max(20),
  logic: z.enum(["AND", "OR"]).optional(),
  sortBy: z.string().max(80).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export async function advancedFilter(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = advancedFilterSchema.parse(req.body);
    const data = await SearchSvc.advancedFilter(companyId, dto as SearchSvc.AdvancedFilterRequest);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

export async function getAllowedFields(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json({ success: true, data: SearchSvc.ALLOWED_FIELDS });
  } catch (err) { next(err); }
}

// ============================================================================
// E-COMMERCE GENERAL (multi-platform)
// ============================================================================
const connectEcommerceSchema = z.object({
  platform: z.string().min(1).max(50),
  shopDomain: z.string().min(3).max(200),
  accessToken: z.string().min(1).max(500),
  apiKey: z.string().max(500).optional(),
  apiSecret: z.string().max(500).optional(),
  region: z.string().max(50).optional(),
  currency: z.string().max(10).optional(),
  metadata: z.record(z.any()).optional(),
});

export async function ecommerceListCatalog(req: Request, res: Response, next: NextFunction) {
  try {
    const region = req.query.region as "mena" | "turkey" | "global" | undefined;
    const data = EcommerceSvc.getCatalog(region);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

export async function ecommerceListStores(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await EcommerceSvc.listStores(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

export async function ecommerceConnect(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = connectEcommerceSchema.parse(req.body);
    const data = await EcommerceSvc.connectStore(companyId, dto as EcommerceSvc.ConnectStoreDto);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

export async function ecommerceDisconnect(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await EcommerceSvc.disconnectStore(companyId, req.params.id as string);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}

export async function ecommerceSync(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const data = await EcommerceSvc.syncStore(companyId, req.params.id as string);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
}
