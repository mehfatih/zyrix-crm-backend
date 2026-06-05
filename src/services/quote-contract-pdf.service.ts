// ============================================================================
// QUOTE / CONTRACT PDF SERVICE — Sprint 5 (Phase C)
// ----------------------------------------------------------------------------
// Renders a single Quote or Contract record to a PDF Buffer using the pdfkit
// engine already bundled for export.service (we REUSE the engine — we do not
// add a new one). The output is what Save-to-Drive uploads.
//
// NOTE: pdfkit's built-in Helvetica uses WinAnsi encoding, so Latin (incl.
// Turkish) renders well; complex Arabic shaping is a known limitation of the
// existing engine and is unchanged here.
// ============================================================================

import { prisma } from "../config/database";
import { integrationError } from "../lib/errors/integrationErrors";
import * as cpqCalc from "./cpq-calc.service";

export interface GeneratedPdf {
  buffer: Buffer;
  filename: string;
}

const BRAND = "#0891B2";
const INK = "#1e293b";
const MUTED = "#64748b";

function money(value: unknown, currency: string): string {
  const n = Number(value ?? 0);
  return `${currency} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fileSafe(s: string): string {
  return (s || "")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

function dateStr(d: Date | null | undefined): string {
  return d ? new Date(d).toISOString().split("T")[0] : "—";
}

// ──────────────────────────────────────────────────────────────────────
// QUOTE
// ──────────────────────────────────────────────────────────────────────
export async function generateQuotePdf(
  companyId: string,
  quoteId: string
): Promise<GeneratedPdf> {
  const quote = await prisma.quote.findFirst({
    where: { id: quoteId, companyId },
    include: {
      customer: { select: { fullName: true, email: true, phone: true, companyName: true } },
      company: { select: { name: true } },
      items: { orderBy: { position: "asc" } },
    },
  });
  if (!quote) {
    throw integrationError("GOOGLE_API_FAILED", "Quote not found", { companyId, platform: "google" });
  }

  const PDFDocument = (await import("pdfkit")).default;
  const doc = new PDFDocument({ size: "A4", margin: 48 });

  const buffer = await render(doc, (d) => {
    docHeader(d, quote.company?.name ?? "Zyrix CRM", "QUOTE", quote.quoteNumber, quote.status);
    partyBlock(d, quote.customer, {
      Issued: dateStr(quote.issuedAt),
      "Valid until": dateStr(quote.validUntil),
    });

    // Line-items table.
    const cols = [
      { key: "name", label: "Item", w: 200 },
      { key: "qty", label: "Qty", w: 50 },
      { key: "unit", label: "Unit", w: 80 },
      { key: "tax", label: "Tax %", w: 50 },
      { key: "total", label: "Total", w: 90 },
    ];
    const startX = d.page.margins.left;
    const tableWidth = cols.reduce((s, c) => s + c.w, 0);
    let y = d.y + 8;

    d.fontSize(9).fillColor("#ffffff");
    d.rect(startX, y, tableWidth, 20).fill(BRAND);
    let x = startX;
    for (const c of cols) {
      d.fillColor("#ffffff").text(c.label, x + 4, y + 6, { width: c.w - 8, ellipsis: true });
      x += c.w;
    }
    y += 20;

    d.fontSize(9).fillColor(INK);
    for (const it of quote.items) {
      if (y > d.page.height - d.page.margins.bottom - 80) {
        d.addPage();
        y = d.page.margins.top;
      }
      // Per-line total via the shared CPQ calc service (single source of truth).
      const line = cpqCalc.computeLine({
        quantity: Number(it.quantity),
        unitPrice: Number(it.unitPrice),
        discountPct: Number(it.discountPercent),
        taxPct: Number(it.taxPercent),
      });
      const cells: Record<string, string> = {
        name: it.name + (it.description ? ` — ${it.description}` : ""),
        qty: String(Number(it.quantity)),
        unit: money(it.unitPrice, quote.currency),
        tax: `${Number(it.taxPercent)}%`,
        total: money(line.lineTotal, quote.currency),
      };
      const rowH = 18;
      d.fillColor("#f8fafc").rect(startX, y, tableWidth, rowH).fill();
      d.fillColor(INK);
      x = startX;
      for (const c of cols) {
        d.text(cells[c.key], x + 4, y + 5, { width: c.w - 8, ellipsis: true });
        x += c.w;
      }
      y += rowH;
    }

    // Totals via the shared CPQ calc service — identical to what the UI and the
    // public page show, and to what is stored on the quote (acceptance #1).
    const totals = cpqCalc.computeTotals(
      quote.items.map((it) => ({
        quantity: Number(it.quantity),
        unitPrice: Number(it.unitPrice),
        discountPct: Number(it.discountPercent),
        taxPct: Number(it.taxPercent),
      }))
    );
    d.y = y + 12;
    totalsBlock(d, [
      ["Subtotal", money(totals.subtotal, quote.currency)],
      ["Discount", money(totals.discountTotal, quote.currency)],
      ["Tax", money(totals.taxTotal, quote.currency)],
      ["Total", money(totals.grandTotal, quote.currency)],
    ]);

    notesBlock(d, quote.notes, quote.terms);
  });

  const customerName = quote.customer?.companyName || quote.customer?.fullName || "Customer";
  return { buffer, filename: `Quote-${fileSafe(quote.quoteNumber)}-${fileSafe(customerName)}.pdf` };
}

// ──────────────────────────────────────────────────────────────────────
// CONTRACT
// ──────────────────────────────────────────────────────────────────────
export async function generateContractPdf(
  companyId: string,
  contractId: string
): Promise<GeneratedPdf> {
  const contract = await prisma.contract.findFirst({
    where: { id: contractId, companyId },
    include: {
      customer: { select: { fullName: true, email: true, phone: true, companyName: true } },
      company: { select: { name: true } },
    },
  });
  if (!contract) {
    throw integrationError("GOOGLE_API_FAILED", "Contract not found", { companyId, platform: "google" });
  }

  const PDFDocument = (await import("pdfkit")).default;
  const doc = new PDFDocument({ size: "A4", margin: 48 });

  const buffer = await render(doc, (d) => {
    docHeader(d, contract.company?.name ?? "Zyrix CRM", "CONTRACT", contract.contractNumber, contract.status);
    partyBlock(d, contract.customer, {
      Start: dateStr(contract.startDate),
      End: dateStr(contract.endDate),
      Signed: dateStr(contract.signedAt),
    });

    d.moveDown(0.5);
    if (contract.title) {
      d.fontSize(12).fillColor(INK).text(contract.title);
      d.moveDown(0.3);
    }
    if (contract.description) {
      d.fontSize(10).fillColor(MUTED).text(contract.description);
      d.moveDown(0.5);
    }

    totalsBlock(d, [["Contract value", money(contract.value, contract.currency)]]);
    notesBlock(d, contract.notes, contract.terms);
  });

  const customerName = contract.customer?.companyName || contract.customer?.fullName || "Customer";
  return {
    buffer,
    filename: `Contract-${fileSafe(contract.contractNumber)}-${fileSafe(customerName)}.pdf`,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Shared pdfkit helpers
// ──────────────────────────────────────────────────────────────────────
function render(
  doc: PDFKit.PDFDocument,
  draw: (d: PDFKit.PDFDocument) => void
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      draw(doc);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function docHeader(
  d: PDFKit.PDFDocument,
  companyName: string,
  docType: string,
  number: string,
  status: string
) {
  d.fontSize(20).fillColor(BRAND).text(companyName, { continued: false });
  d.fontSize(14).fillColor(INK).text(`${docType} ${number}`);
  d.fontSize(9).fillColor(MUTED).text(`Status: ${status}`);
  d.moveDown(0.8);
}

function partyBlock(
  d: PDFKit.PDFDocument,
  customer: { fullName: string; email: string | null; phone: string | null; companyName: string | null } | null,
  meta: Record<string, string>
) {
  const topY = d.y;
  const leftX = d.page.margins.left;
  const rightX = d.page.width / 2 + 20;

  d.fontSize(9).fillColor(MUTED).text("BILL TO", leftX, topY);
  d.fontSize(11).fillColor(INK).text(customer?.fullName ?? "—", leftX, d.y);
  if (customer?.companyName) d.fontSize(9).fillColor(MUTED).text(customer.companyName, leftX, d.y);
  if (customer?.email) d.fontSize(9).fillColor(MUTED).text(customer.email, leftX, d.y);
  if (customer?.phone) d.fontSize(9).fillColor(MUTED).text(customer.phone, leftX, d.y);
  const leftEndY = d.y;

  let my = topY;
  for (const [k, v] of Object.entries(meta)) {
    d.fontSize(9).fillColor(MUTED).text(`${k}: `, rightX, my, { continued: true });
    d.fillColor(INK).text(v);
    my = d.y;
  }

  d.y = Math.max(leftEndY, my) + 10;
  d.moveTo(d.page.margins.left, d.y)
    .lineTo(d.page.width - d.page.margins.right, d.y)
    .strokeColor("#e2e8f0")
    .stroke();
  d.moveDown(0.5);
}

function totalsBlock(d: PDFKit.PDFDocument, rows: [string, string][]) {
  const rightX = d.page.width - d.page.margins.right - 220;
  for (let i = 0; i < rows.length; i++) {
    const [label, val] = rows[i];
    const isTotal = i === rows.length - 1;
    d.fontSize(isTotal ? 12 : 10)
      .fillColor(isTotal ? BRAND : MUTED)
      .text(label, rightX, d.y, { width: 120, continued: true });
    d.fillColor(isTotal ? INK : INK).text(val, { width: 100, align: "right" });
  }
  d.moveDown(0.8);
}

function notesBlock(d: PDFKit.PDFDocument, notes: string | null, terms: string | null) {
  if (notes) {
    d.fontSize(9).fillColor(MUTED).text("Notes");
    d.fontSize(10).fillColor(INK).text(notes);
    d.moveDown(0.4);
  }
  if (terms) {
    d.fontSize(9).fillColor(MUTED).text("Terms");
    d.fontSize(10).fillColor(INK).text(terms);
  }
}
