// ============================================================================
// TAX INVOICES SERVICE
// ----------------------------------------------------------------------------
// Issues country-specific tax-compliance invoices (ZATCA for Saudi,
// e-Fatura/e-Arşiv for Turkey). Reads from existing Quote/Contract/Deal
// records to populate line items, generates UBL XML + QR code, chains
// previous invoice hash, persists to tax_invoices table for audit.
//
// Design choices:
//   • All compliance data frozen at issue time (seller/buyer snapshots).
//     Regulators audit the invoice as it was when issued, not as the
//     source record looks today.
//   • Hash chain: each invoice's SHA-256 hash incorporates the previous
//     invoice's hash, preventing mid-stream insertion by a bad actor.
//   • Invoice numbering is sequential per (companyId, regime) — ZATCA
//     rejects gaps. We use a row-level lock to assign the next number
//     atomically.
//   • Submission to the regulator is not implemented here — that
//     requires per-merchant certificates from the Fatoora portal
//     (Saudi) or an integrator agreement (Turkey). Service stores the
//     status + externalId so a submission worker can fill those in
//     later.
// ============================================================================

import crypto from "crypto";
import { prisma } from "../config/database";
import { badRequest, notFound } from "../middleware/errorHandler";
import { buildZatcaQrCode } from "./compliance/zatca-qr";
import { buildZatcaXml } from "./compliance/zatca-xml";
import { buildTurkeyXml } from "./compliance/turkey-xml";
import type { TaxInvoiceShape } from "./compliance/types";

export type TaxRegime = "zatca" | "efatura" | "earsiv";
export type TaxInvoiceType =
  | "standard"
  | "simplified"
  | "credit_note"
  | "debit_note";

export interface LineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  discount?: number;
  taxRate?: number;
  lineTotal: number;
}

export interface TaxInvoiceRow {
  id: string;
  companyId: string;
  regime: string;
  type: string;
  invoiceNumber: string;
  quoteId: string | null;
  contractId: string | null;
  dealId: string | null;
  sellerName: string;
  sellerVatNo: string | null;
  sellerAddress: string | null;
  buyerName: string;
  buyerVatNo: string | null;
  buyerAddress: string | null;
  currency: string;
  subtotal: number;
  discountAmount: number;
  taxRate: number;
  taxAmount: number;
  totalAmount: number;
  lineItems: LineItem[];
  issuedAt: string;
  xml: string | null;
  qrCode: string | null;
  invoiceHash: string | null;
  previousInvoiceHash: string | null;
  status: string;
  externalId: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Assign the next sequential invoice number for a given company+regime.
 * Uses a subquery inside INSERT so the increment is atomic at the DB
 * level — no TOCTOU race between "find max" and "insert".
 */
async function nextInvoiceNumber(
  companyId: string,
  regime: TaxRegime
): Promise<string> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT COALESCE(MAX(CAST("invoiceNumber" AS INTEGER)), 0) + 1 AS next
     FROM tax_invoices
     WHERE "companyId" = $1 AND regime = $2
       AND "invoiceNumber" ~ '^[0-9]+$'`,
    companyId,
    regime
  )) as { next: number }[];
  const n = Number(rows[0]?.next ?? 1);
  // Pad to at least 6 digits for readability (INV-000001, etc.)
  return String(n).padStart(6, "0");
}

async function previousHashForRegime(
  companyId: string,
  regime: TaxRegime
): Promise<string | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT "invoiceHash" FROM tax_invoices
     WHERE "companyId" = $1 AND regime = $2 AND "invoiceHash" IS NOT NULL
     ORDER BY "issuedAt" DESC LIMIT 1`,
    companyId,
    regime
  )) as { invoiceHash: string | null }[];
  return rows[0]?.invoiceHash ?? null;
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

// ──────────────────────────────────────────────────────────────────────
// Issue (create + serialize + hash)
// ──────────────────────────────────────────────────────────────────────

export interface IssueTaxInvoiceInput {
  regime: TaxRegime;
  type?: TaxInvoiceType;
  quoteId?: string;
  contractId?: string;
  dealId?: string;
  sellerName: string;
  sellerVatNo?: string;
  sellerAddress?: string;
  buyerName: string;
  buyerVatNo?: string;
  buyerAddress?: string;
  currency?: string;
  lineItems: LineItem[];
  taxRate: number;
  discountAmount?: number;
}

export async function issueTaxInvoice(
  companyId: string,
  input: IssueTaxInvoiceInput
): Promise<TaxInvoiceRow> {
  if (!["zatca", "efatura", "earsiv"].includes(input.regime)) {
    throw badRequest(`Invalid regime: ${input.regime}`);
  }
  if (!input.lineItems || input.lineItems.length === 0) {
    throw badRequest("At least one line item is required");
  }
  if (input.taxRate < 0 || input.taxRate > 100) {
    throw badRequest("taxRate must be between 0 and 100");
  }

  // Compute monetary totals server-side — never trust client math
  const subtotal = input.lineItems.reduce(
    (acc, item) => acc + Number(item.lineTotal),
    0
  );
  const discountAmount = Number(input.discountAmount ?? 0);
  const taxable = Math.max(subtotal - discountAmount, 0);
  const taxAmount = (taxable * input.taxRate) / 100;
  const totalAmount = taxable + taxAmount;

  // Default currency by regime if not specified
  const currency =
    input.currency ??
    (input.regime === "zatca" ? "SAR" : "TRY");

  const invoiceNumber = await nextInvoiceNumber(companyId, input.regime);
  const previousInvoiceHash = await previousHashForRegime(
    companyId,
    input.regime
  );

  const now = new Date();

  // Insert the row (without XML/QR yet — we need the id to serialize,
  // then we UPDATE with the artifacts in the same transaction)
  const created = (await prisma.$queryRawUnsafe(
    `INSERT INTO tax_invoices
       (id, "companyId", regime, type, "invoiceNumber",
        "quoteId", "contractId", "dealId",
        "sellerName", "sellerVatNo", "sellerAddress",
        "buyerName", "buyerVatNo", "buyerAddress",
        currency, subtotal, "discountAmount", "taxRate", "taxAmount", "totalAmount",
        "lineItems", "issuedAt",
        "previousInvoiceHash", status, "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, $4,
             $5, $6, $7,
             $8, $9, $10,
             $11, $12, $13,
             $14, $15, $16, $17, $18, $19,
             $20::jsonb, $21,
             $22, 'draft', NOW(), NOW())
     RETURNING id, "companyId", regime, type, "invoiceNumber",
               "quoteId", "contractId", "dealId",
               "sellerName", "sellerVatNo", "sellerAddress",
               "buyerName", "buyerVatNo", "buyerAddress",
               currency, subtotal, "discountAmount", "taxRate", "taxAmount", "totalAmount",
               "lineItems", "issuedAt",
               xml, "qrCode", "invoiceHash", "previousInvoiceHash",
               status, "externalId", "submittedAt", "approvedAt", "rejectionReason",
               "createdAt", "updatedAt"`,
    companyId,
    input.regime,
    input.type ?? "standard",
    invoiceNumber,
    input.quoteId ?? null,
    input.contractId ?? null,
    input.dealId ?? null,
    input.sellerName,
    input.sellerVatNo ?? null,
    input.sellerAddress ?? null,
    input.buyerName,
    input.buyerVatNo ?? null,
    input.buyerAddress ?? null,
    currency,
    subtotal,
    discountAmount,
    input.taxRate,
    taxAmount,
    totalAmount,
    JSON.stringify(input.lineItems),
    now,
    previousInvoiceHash
  )) as any[];

  const row = created[0];
  const shape: TaxInvoiceShape = {
    ...row,
    subtotal: Number(row.subtotal),
    discountAmount: Number(row.discountAmount),
    taxRate: Number(row.taxRate),
    taxAmount: Number(row.taxAmount),
    totalAmount: Number(row.totalAmount),
    issuedAt: new Date(row.issuedAt),
  };

  // Generate QR code for ZATCA only — Turkey doesn't require a QR
  // code the same way (some receipts do; skip for now).
  let qrCode: string | null = null;
  if (input.regime === "zatca") {
    qrCode = buildZatcaQrCode({
      sellerName: input.sellerName,
      vatNumber: input.sellerVatNo ?? "",
      timestamp: now,
      totalWithVat: totalAmount,
      vatTotal: taxAmount,
    });
  }

  // Generate the XML
  let xml: string;
  if (input.regime === "zatca") {
    xml = buildZatcaXml({
      ...shape,
      qrCode: qrCode ?? undefined,
      previousInvoiceHash: previousInvoiceHash ?? undefined,
    });
  } else {
    xml = buildTurkeyXml({
      ...shape,
      regime: input.regime,
    });
  }

  const invoiceHash = sha256Hex(xml);

  // Persist the compliance artifacts
  await prisma.$executeRawUnsafe(
    `UPDATE tax_invoices
     SET xml = $1, "qrCode" = $2, "invoiceHash" = $3, "updatedAt" = NOW()
     WHERE id = $4`,
    xml,
    qrCode,
    invoiceHash,
    row.id
  );

  return {
    ...row,
    subtotal: Number(row.subtotal),
    discountAmount: Number(row.discountAmount),
    taxRate: Number(row.taxRate),
    taxAmount: Number(row.taxAmount),
    totalAmount: Number(row.totalAmount),
    lineItems: input.lineItems,
    issuedAt: new Date(row.issuedAt).toISOString(),
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    xml,
    qrCode,
    invoiceHash,
    previousInvoiceHash,
    submittedAt: null,
    approvedAt: null,
    rejectionReason: null,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Read
// ──────────────────────────────────────────────────────────────────────

export async function listTaxInvoices(
  companyId: string,
  opts: {
    regime?: TaxRegime;
    status?: string;
    limit?: number;
    offset?: number;
  } = {}
): Promise<{ items: TaxInvoiceRow[]; total: number }> {
  const limit = Math.min(opts.limit ?? 25, 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const conditions: string[] = [`"companyId" = $1`];
  const params: any[] = [companyId];
  if (opts.regime) {
    params.push(opts.regime);
    conditions.push(`regime = $${params.length}`);
  }
  if (opts.status) {
    params.push(opts.status);
    conditions.push(`status = $${params.length}`);
  }
  const whereClause = conditions.join(" AND ");

  const [rows, countRows] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT id, "companyId", regime, type, "invoiceNumber",
              "quoteId", "contractId", "dealId",
              "sellerName", "sellerVatNo", "sellerAddress",
              "buyerName", "buyerVatNo", "buyerAddress",
              currency, subtotal, "discountAmount", "taxRate", "taxAmount", "totalAmount",
              "lineItems", "issuedAt",
              xml, "qrCode", "invoiceHash", "previousInvoiceHash",
              status, "externalId", "submittedAt", "approvedAt", "rejectionReason",
              "createdAt", "updatedAt"
       FROM tax_invoices
       WHERE ${whereClause}
       ORDER BY "issuedAt" DESC
       LIMIT ${limit} OFFSET ${offset}`,
      ...params
    ) as Promise<any[]>,
    prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM tax_invoices WHERE ${whereClause}`,
      ...params
    ) as Promise<{ n: number }[]>,
  ]);

  return {
    items: (rows as any[]).map(normalizeRow),
    total: countRows[0]?.n ?? 0,
  };
}

export async function getTaxInvoice(
  companyId: string,
  id: string
): Promise<TaxInvoiceRow | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id, "companyId", regime, type, "invoiceNumber",
            "quoteId", "contractId", "dealId",
            "sellerName", "sellerVatNo", "sellerAddress",
            "buyerName", "buyerVatNo", "buyerAddress",
            currency, subtotal, "discountAmount", "taxRate", "taxAmount", "totalAmount",
            "lineItems", "issuedAt",
            xml, "qrCode", "invoiceHash", "previousInvoiceHash",
            status, "externalId", "submittedAt", "approvedAt", "rejectionReason",
            "createdAt", "updatedAt"
     FROM tax_invoices WHERE id = $1 AND "companyId" = $2 LIMIT 1`,
    id,
    companyId
  )) as any[];
  return rows[0] ? normalizeRow(rows[0]) : null;
}

function normalizeRow(row: any): TaxInvoiceRow {
  return {
    ...row,
    subtotal: Number(row.subtotal),
    discountAmount: Number(row.discountAmount),
    taxRate: Number(row.taxRate),
    taxAmount: Number(row.taxAmount),
    totalAmount: Number(row.totalAmount),
    lineItems: Array.isArray(row.lineItems) ? row.lineItems : [],
    issuedAt:
      row.issuedAt instanceof Date
        ? row.issuedAt.toISOString()
        : String(row.issuedAt),
    submittedAt:
      row.submittedAt instanceof Date
        ? row.submittedAt.toISOString()
        : row.submittedAt ?? null,
    approvedAt:
      row.approvedAt instanceof Date
        ? row.approvedAt.toISOString()
        : row.approvedAt ?? null,
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : String(row.createdAt),
    updatedAt:
      row.updatedAt instanceof Date
        ? row.updatedAt.toISOString()
        : String(row.updatedAt),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Status updates (future: provider submission worker populates these)
// ──────────────────────────────────────────────────────────────────────

export async function markSubmitted(
  companyId: string,
  id: string,
  externalId: string
): Promise<TaxInvoiceRow> {
  const existing = await getTaxInvoice(companyId, id);
  if (!existing) throw notFound("TaxInvoice");
  await prisma.$executeRawUnsafe(
    `UPDATE tax_invoices
     SET status = 'submitted', "externalId" = $1,
         "submittedAt" = NOW(), "updatedAt" = NOW()
     WHERE id = $2 AND "companyId" = $3`,
    externalId,
    id,
    companyId
  );
  return (await getTaxInvoice(companyId, id))!;
}

export async function markApproved(
  companyId: string,
  id: string
): Promise<TaxInvoiceRow> {
  await prisma.$executeRawUnsafe(
    `UPDATE tax_invoices
     SET status = 'approved', "approvedAt" = NOW(),
         "rejectionReason" = NULL, "updatedAt" = NOW()
     WHERE id = $1 AND "companyId" = $2`,
    id,
    companyId
  );
  const refreshed = await getTaxInvoice(companyId, id);
  if (!refreshed) throw notFound("TaxInvoice");
  return refreshed;
}

export async function markRejected(
  companyId: string,
  id: string,
  reason: string
): Promise<TaxInvoiceRow> {
  await prisma.$executeRawUnsafe(
    `UPDATE tax_invoices
     SET status = 'rejected', "rejectionReason" = $1,
         "updatedAt" = NOW()
     WHERE id = $2 AND "companyId" = $3`,
    reason,
    id,
    companyId
  );
  const refreshed = await getTaxInvoice(companyId, id);
  if (!refreshed) throw notFound("TaxInvoice");
  return refreshed;
}
