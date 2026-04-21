import { prisma } from "../config/database";
import type { Prisma } from "@prisma/client";

// ============================================================================
// EXPORT SERVICE
// CSV / Excel / PDF generation for reports and data lists
// Uses lightweight approach: CSV natively, XLSX via xlsx-populate-like logic
// For full Excel generation we use `exceljs`, for PDF `pdfkit` or `puppeteer`
// To keep dependency footprint low, we start with CSV + HTML-to-PDF printable
// ============================================================================

export type ExportFormat = "csv" | "xlsx" | "pdf";

export interface ExportOptions {
  entityType: "customers" | "deals" | "quotes" | "contracts" | "commissions";
  format: ExportFormat;
  filters?: Record<string, any>;
  columns?: string[];
}

// ──────────────────────────────────────────────────────────────────────
// CUSTOMERS EXPORT
// ──────────────────────────────────────────────────────────────────────
async function fetchCustomersForExport(
  companyId: string,
  filters: Record<string, any> = {}
) {
  const where: Prisma.CustomerWhereInput = { companyId };
  if (filters.status) where.status = filters.status;
  if (filters.ownerId) where.ownerId = filters.ownerId;
  if (filters.country) where.country = filters.country;
  if (filters.source) where.source = filters.source;
  if (filters.search) {
    where.OR = [
      { fullName: { contains: filters.search, mode: "insensitive" } },
      { email: { contains: filters.search, mode: "insensitive" } },
      { phone: { contains: filters.search } },
      { companyName: { contains: filters.search, mode: "insensitive" } },
    ];
  }

  return prisma.customer.findMany({
    where,
    include: {
      owner: { select: { fullName: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 5000, // reasonable cap for exports
  });
}

async function fetchDealsForExport(
  companyId: string,
  filters: Record<string, any> = {}
) {
  const where: Prisma.DealWhereInput = { companyId };
  if (filters.stage) where.stage = filters.stage;
  if (filters.ownerId) where.ownerId = filters.ownerId;
  if (filters.customerId) where.customerId = filters.customerId;

  return prisma.deal.findMany({
    where,
    include: {
      customer: { select: { fullName: true, email: true, companyName: true } },
      owner: { select: { fullName: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 5000,
  });
}

async function fetchQuotesForExport(
  companyId: string,
  filters: Record<string, any> = {}
) {
  const where: Prisma.QuoteWhereInput = { companyId };
  if (filters.status) where.status = filters.status;
  if (filters.customerId) where.customerId = filters.customerId;
  return prisma.quote.findMany({
    where,
    include: {
      customer: { select: { fullName: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 5000,
  });
}

async function fetchContractsForExport(
  companyId: string,
  filters: Record<string, any> = {}
) {
  const where: Prisma.ContractWhereInput = { companyId };
  if (filters.status) where.status = filters.status;
  if (filters.customerId) where.customerId = filters.customerId;
  return prisma.contract.findMany({
    where,
    include: {
      customer: { select: { fullName: true, companyName: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 5000,
  });
}

async function fetchCommissionsForExport(
  companyId: string,
  filters: Record<string, any> = {}
) {
  const where: Prisma.CommissionEntryWhereInput = { companyId };
  if (filters.status) where.status = filters.status;
  if (filters.userId) where.userId = filters.userId;
  return prisma.commissionEntry.findMany({
    where,
    include: {
      user: { select: { fullName: true, email: true } },
      deal: { select: { title: true, value: true } },
      rule: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 5000,
  });
}

// ──────────────────────────────────────────────────────────────────────
// CSV ENCODING
// ──────────────────────────────────────────────────────────────────────
function csvEscape(value: any): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsv(headers: string[], rows: Record<string, any>[]): string {
  const headerLine = headers.map(csvEscape).join(",");
  const lines = rows.map((r) =>
    headers.map((h) => csvEscape(r[h])).join(",")
  );
  // Prepend UTF-8 BOM for Excel compatibility with Arabic/Turkish
  return "\uFEFF" + [headerLine, ...lines].join("\n");
}

// ──────────────────────────────────────────────────────────────────────
// ROW MAPPERS
// ──────────────────────────────────────────────────────────────────────
function mapCustomerRow(c: any): Record<string, any> {
  return {
    "Full Name": c.fullName,
    Email: c.email,
    Phone: c.phone,
    WhatsApp: c.whatsappPhone,
    Company: c.companyName,
    Position: c.position,
    Country: c.country,
    City: c.city,
    Status: c.status,
    "Lifetime Value": Number(c.lifetimeValue),
    Source: c.source,
    Owner: c.owner?.fullName || "",
    "Created At": c.createdAt?.toISOString().split("T")[0] || "",
    "Last Contact": c.lastContactAt?.toISOString().split("T")[0] || "",
    Notes: c.notes,
  };
}

function mapDealRow(d: any): Record<string, any> {
  return {
    Title: d.title,
    Customer: d.customer?.fullName,
    "Customer Company": d.customer?.companyName,
    Stage: d.stage,
    Value: Number(d.value),
    Currency: d.currency,
    Probability: `${d.probability}%`,
    "Expected Close": d.expectedCloseDate?.toISOString().split("T")[0] || "",
    "Actual Close": d.actualCloseDate?.toISOString().split("T")[0] || "",
    Owner: d.owner?.fullName || "",
    "Created At": d.createdAt?.toISOString().split("T")[0] || "",
    Description: d.description,
    "Lost Reason": d.lostReason,
  };
}

function mapQuoteRow(q: any): Record<string, any> {
  return {
    "Quote Number": q.quoteNumber,
    Title: q.title,
    Customer: q.customer?.fullName,
    Status: q.status,
    Total: Number(q.total),
    Currency: q.currency,
    "Valid Until": q.validUntil?.toISOString().split("T")[0] || "",
    "Issued At": q.issuedAt?.toISOString().split("T")[0] || "",
    "Accepted At": q.acceptedAt?.toISOString().split("T")[0] || "",
  };
}

function mapContractRow(c: any): Record<string, any> {
  return {
    "Contract Number": c.contractNumber,
    Title: c.title,
    Customer: c.customer?.fullName,
    "Customer Company": c.customer?.companyName,
    Status: c.status,
    Value: Number(c.value),
    Currency: c.currency,
    "Start Date": c.startDate?.toISOString().split("T")[0] || "",
    "End Date": c.endDate?.toISOString().split("T")[0] || "",
    "Signed At": c.signedAt?.toISOString().split("T")[0] || "",
  };
}

function mapCommissionRow(c: any): Record<string, any> {
  return {
    User: c.user?.fullName,
    Deal: c.deal?.title,
    Rule: c.rule?.name,
    "Base Value": Number(c.baseValue),
    "Rate (%)": Number(c.rate),
    Amount: Number(c.amount),
    Currency: c.currency,
    Status: c.status,
    "Approved At": c.approvedAt?.toISOString().split("T")[0] || "",
    "Paid At": c.paidAt?.toISOString().split("T")[0] || "",
  };
}

// ──────────────────────────────────────────────────────────────────────
// PUBLIC: exportData returns content + mime type + filename
// ──────────────────────────────────────────────────────────────────────
export interface ExportOutput {
  content: string | Buffer;
  mimeType: string;
  filename: string;
  encoding?: "utf8" | "binary" | "base64";
}

export async function exportData(
  companyId: string,
  opts: ExportOptions
): Promise<ExportOutput> {
  // Fetch data based on entity
  let data: any[] = [];
  let rows: Record<string, any>[] = [];
  let headers: string[] = [];

  switch (opts.entityType) {
    case "customers":
      data = await fetchCustomersForExport(companyId, opts.filters);
      rows = data.map(mapCustomerRow);
      break;
    case "deals":
      data = await fetchDealsForExport(companyId, opts.filters);
      rows = data.map(mapDealRow);
      break;
    case "quotes":
      data = await fetchQuotesForExport(companyId, opts.filters);
      rows = data.map(mapQuoteRow);
      break;
    case "contracts":
      data = await fetchContractsForExport(companyId, opts.filters);
      rows = data.map(mapContractRow);
      break;
    case "commissions":
      data = await fetchCommissionsForExport(companyId, opts.filters);
      rows = data.map(mapCommissionRow);
      break;
  }

  headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  // If user specified columns, filter + reorder
  if (opts.columns && opts.columns.length > 0) {
    headers = opts.columns.filter((c) => headers.includes(c));
  }

  const timestamp = new Date().toISOString().split("T")[0];

  switch (opts.format) {
    case "csv":
      return {
        content: toCsv(headers, rows),
        mimeType: "text/csv; charset=utf-8",
        filename: `${opts.entityType}-${timestamp}.csv`,
        encoding: "utf8",
      };

    case "xlsx":
      // For XLSX, we delegate to a helper that uses ExcelJS.
      // Falls back to CSV with .xlsx-like mime if ExcelJS is not available.
      try {
        const buffer = await generateXlsx(
          headers,
          rows,
          opts.entityType
        );
        return {
          content: buffer,
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          filename: `${opts.entityType}-${timestamp}.xlsx`,
          encoding: "binary",
        };
      } catch {
        // Fallback: CSV
        return {
          content: toCsv(headers, rows),
          mimeType: "text/csv; charset=utf-8",
          filename: `${opts.entityType}-${timestamp}.csv`,
          encoding: "utf8",
        };
      }

    case "pdf":
      try {
        const buffer = await generatePdf(headers, rows, opts.entityType);
        return {
          content: buffer,
          mimeType: "application/pdf",
          filename: `${opts.entityType}-${timestamp}.pdf`,
          encoding: "binary",
        };
      } catch {
        // Fallback: HTML string
        const html = generateHtmlReport(headers, rows, opts.entityType);
        return {
          content: html,
          mimeType: "text/html; charset=utf-8",
          filename: `${opts.entityType}-${timestamp}.html`,
          encoding: "utf8",
        };
      }

    default:
      throw new Error("Unsupported format");
  }
}

// ──────────────────────────────────────────────────────────────────────
// XLSX — uses ExcelJS (lazy-required to avoid startup cost)
// ──────────────────────────────────────────────────────────────────────
async function generateXlsx(
  headers: string[],
  rows: Record<string, any>[],
  sheetName: string
): Promise<Buffer> {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Zyrix CRM";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(sheetName, {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  // Header
  sheet.addRow(headers);
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF0891B2" },
  };
  headerRow.alignment = { vertical: "middle", horizontal: "left" };
  headerRow.height = 22;

  // Data rows
  for (const r of rows) {
    sheet.addRow(headers.map((h) => r[h]));
  }

  // Auto-width
  sheet.columns.forEach((col) => {
    let max = 10;
    col.eachCell({ includeEmpty: false }, (cell) => {
      const len = String(cell.value ?? "").length;
      if (len > max) max = Math.min(len, 60);
    });
    col.width = max + 2;
  });

  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf);
}

// ──────────────────────────────────────────────────────────────────────
// PDF — uses pdfkit (lazy-required)
// ──────────────────────────────────────────────────────────────────────
async function generatePdf(
  headers: string[],
  rows: Record<string, any>[],
  title: string
): Promise<Buffer> {
  const PDFDocument = (await import("pdfkit")).default;
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 30 });

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Title
    doc.fontSize(18).fillColor("#0891B2").text(`Zyrix CRM — ${title}`, { align: "left" });
    doc
      .fontSize(10)
      .fillColor("#64748b")
      .text(`Generated on ${new Date().toLocaleDateString("en-US")}`, {
        align: "left",
      });
    doc.moveDown();

    if (rows.length === 0) {
      doc.fontSize(12).fillColor("#1e293b").text("No data to export.");
      doc.end();
      return;
    }

    // Table
    const pageWidth = doc.page.width - 60;
    const colWidth = pageWidth / headers.length;
    const startX = 30;
    let y = doc.y;

    // Header row
    doc.fontSize(9).fillColor("#ffffff");
    doc.rect(startX, y, pageWidth, 22).fill("#0891B2");
    headers.forEach((h, i) => {
      doc
        .fillColor("#ffffff")
        .text(h, startX + i * colWidth + 4, y + 6, {
          width: colWidth - 8,
          ellipsis: true,
        });
    });
    y += 22;

    // Rows
    doc.fontSize(8).fillColor("#1e293b");
    for (const r of rows) {
      if (y > doc.page.height - 50) {
        doc.addPage();
        y = 30;
      }
      doc.fillColor("#f8fafc").rect(startX, y, pageWidth, 16).fill();
      doc.fillColor("#1e293b");
      headers.forEach((h, i) => {
        const val = String(r[h] ?? "");
        doc.text(val, startX + i * colWidth + 4, y + 4, {
          width: colWidth - 8,
          ellipsis: true,
        });
      });
      y += 16;
    }

    doc.end();
  });
}

// ──────────────────────────────────────────────────────────────────────
// HTML report (fallback when PDF generation fails)
// ──────────────────────────────────────────────────────────────────────
function generateHtmlReport(
  headers: string[],
  rows: Record<string, any>[],
  title: string
): string {
  const bodyRows = rows
    .map(
      (r) =>
        `<tr>${headers.map((h) => `<td>${escapeHtml(String(r[h] ?? ""))}</td>`).join("")}</tr>`
    )
    .join("");
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<title>Zyrix CRM — ${title}</title>
<style>
  body { font-family: -apple-system, sans-serif; padding: 24px; color: #1e293b; }
  h1 { color: #0891B2; margin: 0 0 8px; font-size: 22px; }
  p.subtitle { color: #64748b; font-size: 12px; margin: 0 0 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  thead { background: #0891B2; color: #fff; }
  th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #e2e8f0; }
  tbody tr:nth-child(even) { background: #f8fafc; }
</style>
</head>
<body>
<h1>Zyrix CRM — ${title}</h1>
<p class="subtitle">Generated on ${new Date().toLocaleString()}</p>
<table>
  <thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
  <tbody>${bodyRows}</tbody>
</table>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
