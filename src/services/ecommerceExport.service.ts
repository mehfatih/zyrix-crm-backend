// ============================================================================
// E-COMMERCE ANALYTICS EXPORT — CSV + PDF generators
// ----------------------------------------------------------------------------
// Converts the EcommerceAnalytics shape produced by reports.service into
// downloadable documents for accountants and leadership reviews.
//
// CSV  — multi-section plain-text file with a simple summary header followed
//        by four tables (totals, per-platform, top customers, daily revenue).
//        No escaping library — we implement RFC-4180-compliant quoting inline.
//
// PDF  — pdfkit document, A4 landscape, brand cyan (#0891B2) accents, matches
//        the visual language of the existing /reports PDF export.
//
// Both functions are pure transforms from the analytics object — they don't
// call the database, so the controller can fetch once and emit either format
// (or both in parallel, if we ever want a zip bundle).
// ============================================================================

import { getEcommerceAnalytics } from "./reports.service";

type Analytics = Awaited<ReturnType<typeof getEcommerceAnalytics>>;

// ──────────────────────────────────────────────────────────────────────
// CSV
// ──────────────────────────────────────────────────────────────────────

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  // RFC 4180: quote if contains comma, quote, CR, or LF. Double inner quotes.
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(values: unknown[]): string {
  return values.map(csvEscape).join(",");
}

export function buildAnalyticsCsv(a: Analytics): string {
  const lines: string[] = [];

  // ─── Header ──────────────────────────────────────────────────────────
  lines.push("Zyrix CRM — E-commerce Analytics");
  lines.push(`Generated,${a.generatedAt}`);
  lines.push(`Window,${a.windowDays} days`);
  lines.push(`Base currency,${a.baseCurrency}`);
  lines.push("");

  // ─── Totals ──────────────────────────────────────────────────────────
  lines.push("TOTALS");
  lines.push(csvRow(["Metric", "Value"]));
  lines.push(csvRow(["Stores connected", a.totals.storesConnected]));
  lines.push(csvRow(["Total customers", a.totals.totalCustomers]));
  lines.push(
    csvRow(["Customers in window", a.totals.totalCustomersInWindow])
  );
  lines.push(
    csvRow(["Customers prior window", a.totals.totalCustomersInPriorWindow])
  );
  lines.push(csvRow(["Customer growth %", a.totals.customerGrowthPct]));
  lines.push(csvRow(["Total orders synced", a.totals.totalOrders]));
  lines.push(
    csvRow([
      `Total won revenue (${a.baseCurrency})`,
      a.totals.totalWonRevenue,
    ])
  );
  lines.push("");

  // ─── Per-platform breakdown ──────────────────────────────────────────
  lines.push("PER-PLATFORM BREAKDOWN");
  lines.push(
    csvRow([
      "Platform",
      "Stores",
      "Customers",
      "Customers (window)",
      "Customers (prior)",
      "Orders",
      "Orders (window)",
      "Won orders",
      `Won revenue (${a.baseCurrency})`,
      `Avg order value (${a.baseCurrency})`,
    ])
  );
  for (const p of a.platforms) {
    lines.push(
      csvRow([
        p.platform,
        p.storesConnected,
        p.customers,
        p.customersInWindow,
        p.customersInPriorWindow,
        p.orders,
        p.ordersInWindow,
        p.wonOrders,
        p.wonRevenue,
        p.avgOrderValue,
      ])
    );
  }
  lines.push("");

  // ─── Top customers ───────────────────────────────────────────────────
  lines.push("TOP CUSTOMERS BY LIFETIME VALUE");
  lines.push(
    csvRow([
      "Rank",
      "Name",
      "Email",
      "Source platform",
      `LTV (${a.baseCurrency})`,
    ])
  );
  a.topCustomers.forEach((c, i) => {
    lines.push(
      csvRow([i + 1, c.fullName, c.email || "", c.source || "", c.lifetimeValue])
    );
  });
  lines.push("");

  // ─── Daily revenue ───────────────────────────────────────────────────
  lines.push("DAILY REVENUE (won orders only)");
  lines.push(csvRow(["Date", `Revenue (${a.baseCurrency})`]));
  for (const d of a.dailyRevenue) {
    lines.push(csvRow([d.date, d.revenue]));
  }

  // UTF-8 BOM so Excel opens Arabic/Turkish correctly on Windows.
  return "\uFEFF" + lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────
// PDF
// ──────────────────────────────────────────────────────────────────────

/**
 * Format a number as a currency amount with thousands separators.
 * Intentionally simple — pdfkit's default font doesn't support Arabic
 * digits gracefully, so we stick with Western digits + locale grouping.
 */
function fmtMoney(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(0)}`;
  }
}

function fmtNum(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

export async function buildAnalyticsPdf(a: Analytics): Promise<Buffer> {
  const PDFDocument = (await import("pdfkit")).default;
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 36 });

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width - 72; // 36px margin each side
    const startX = 36;
    const BRAND = "#0891B2";
    const MUTED = "#64748B";
    const INK = "#0F172A";

    // ─── Header ────────────────────────────────────────────────────────
    doc
      .fontSize(20)
      .fillColor(BRAND)
      .text("Zyrix CRM", startX, 36, { continued: false });
    doc
      .fontSize(14)
      .fillColor(INK)
      .text("E-commerce Analytics Report", startX, 60);
    doc
      .fontSize(9)
      .fillColor(MUTED)
      .text(
        `Generated ${new Date(a.generatedAt).toLocaleString("en-US")}  ·  ` +
          `Window: last ${a.windowDays} days  ·  Base currency: ${a.baseCurrency}`,
        startX,
        82
      );

    // Thin brand divider
    doc
      .moveTo(startX, 100)
      .lineTo(startX + pageWidth, 100)
      .strokeColor(BRAND)
      .lineWidth(1.5)
      .stroke();

    let y = 115;

    // ─── Totals KPI grid (4 columns) ───────────────────────────────────
    const kpis: Array<[string, string, string]> = [
      [
        "Total revenue",
        fmtMoney(a.totals.totalWonRevenue, a.baseCurrency),
        `${fmtNum(a.totals.totalOrders)} orders`,
      ],
      [
        "Customers",
        fmtNum(a.totals.totalCustomers),
        `${a.totals.customerGrowthPct > 0 ? "+" : ""}${a.totals.customerGrowthPct}% vs prior`,
      ],
      [
        "Stores",
        fmtNum(a.totals.storesConnected),
        `${a.platforms.length} platforms`,
      ],
      [
        "New in window",
        fmtNum(a.totals.totalCustomersInWindow),
        `last ${a.windowDays} days`,
      ],
    ];
    const kpiWidth = (pageWidth - 24) / 4;
    kpis.forEach(([label, value, hint], i) => {
      const x = startX + i * (kpiWidth + 8);
      doc
        .roundedRect(x, y, kpiWidth, 64, 6)
        .fillColor("#F0F9FF")
        .fill();
      doc
        .fontSize(9)
        .fillColor(MUTED)
        .text(label, x + 10, y + 10, { width: kpiWidth - 20 });
      doc
        .fontSize(16)
        .fillColor(INK)
        .text(value, x + 10, y + 24, { width: kpiWidth - 20 });
      doc
        .fontSize(8)
        .fillColor(MUTED)
        .text(hint, x + 10, y + 48, { width: kpiWidth - 20 });
    });
    y += 80;

    // ─── Per-platform breakdown table ──────────────────────────────────
    y = drawSectionHeader(doc, "Per-platform breakdown", startX, y, BRAND);
    y = drawTable(
      doc,
      [
        { label: "Platform", width: 100 },
        { label: "Stores", width: 60, align: "right" },
        { label: "Customers", width: 80, align: "right" },
        { label: "Orders", width: 70, align: "right" },
        { label: "Won orders", width: 80, align: "right" },
        { label: `Revenue (${a.baseCurrency})`, width: 120, align: "right" },
        { label: `AOV (${a.baseCurrency})`, width: 110, align: "right" },
      ],
      a.platforms.map((p) => [
        p.platform,
        fmtNum(p.storesConnected),
        fmtNum(p.customers),
        fmtNum(p.orders),
        fmtNum(p.wonOrders),
        fmtMoney(p.wonRevenue, a.baseCurrency),
        fmtMoney(p.avgOrderValue, a.baseCurrency),
      ]),
      startX,
      y,
      BRAND,
      INK,
      MUTED
    );
    y += 20;

    // ─── Top customers ─────────────────────────────────────────────────
    if (a.topCustomers.length > 0) {
      // Check if we need a new page before rendering this section
      if (y > doc.page.height - 200) {
        doc.addPage();
        y = 50;
      }
      y = drawSectionHeader(doc, "Top customers by lifetime value", startX, y, BRAND);
      y = drawTable(
        doc,
        [
          { label: "#", width: 30, align: "right" },
          { label: "Customer", width: 200 },
          { label: "Source", width: 100 },
          { label: "Email", width: 200 },
          { label: `LTV (${a.baseCurrency})`, width: 140, align: "right" },
        ],
        a.topCustomers.map((c, i) => [
          String(i + 1),
          c.fullName,
          c.source || "—",
          c.email || "—",
          fmtMoney(c.lifetimeValue, a.baseCurrency),
        ]),
        startX,
        y,
        BRAND,
        INK,
        MUTED
      );
      y += 20;
    }

    // ─── Store health ──────────────────────────────────────────────────
    if (a.stores.length > 0) {
      if (y > doc.page.height - 180) {
        doc.addPage();
        y = 50;
      }
      y = drawSectionHeader(doc, "Store health", startX, y, BRAND);
      y = drawTable(
        doc,
        [
          { label: "Platform", width: 100 },
          { label: "Domain", width: 240 },
          { label: "Status", width: 80 },
          { label: "Customers", width: 90, align: "right" },
          { label: "Orders", width: 80, align: "right" },
          { label: "Last sync", width: 150 },
        ],
        a.stores.map((s) => [
          s.platform,
          s.shopDomain,
          s.syncStatus || "idle",
          fmtNum(s.totalCustomersImported),
          fmtNum(s.totalOrdersImported),
          s.lastSyncAt
            ? new Date(s.lastSyncAt).toLocaleString("en-US", {
                dateStyle: "short",
                timeStyle: "short",
              })
            : "never",
        ]),
        startX,
        y,
        BRAND,
        INK,
        MUTED
      );
    }

    // ─── Footer on every page ──────────────────────────────────────────
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc
        .fontSize(7)
        .fillColor(MUTED)
        .text(
          `Zyrix CRM — confidential — page ${i - range.start + 1} of ${range.count}`,
          36,
          doc.page.height - 24,
          { width: doc.page.width - 72, align: "center" }
        );
    }

    doc.end();
  });
}

// ──────────────────────────────────────────────────────────────────────
// PDF DRAWING HELPERS
// ──────────────────────────────────────────────────────────────────────

function drawSectionHeader(
  doc: any,
  title: string,
  x: number,
  y: number,
  brand: string
): number {
  doc
    .fontSize(12)
    .fillColor(brand)
    .text(title, x, y);
  doc
    .moveTo(x, y + 18)
    .lineTo(x + 120, y + 18)
    .strokeColor(brand)
    .lineWidth(1)
    .stroke();
  return y + 28;
}

interface ColSpec {
  label: string;
  width: number;
  align?: "left" | "right";
}

function drawTable(
  doc: any,
  cols: ColSpec[],
  rows: string[][],
  startX: number,
  startY: number,
  brand: string,
  ink: string,
  muted: string
): number {
  const rowHeight = 20;
  const headerHeight = 22;
  let y = startY;

  // Header bar
  const totalWidth = cols.reduce((s, c) => s + c.width, 0);
  doc.rect(startX, y, totalWidth, headerHeight).fillColor(brand).fill();

  let cx = startX;
  doc.fontSize(9).fillColor("#ffffff");
  for (const col of cols) {
    doc.text(col.label, cx + 6, y + 7, {
      width: col.width - 12,
      align: col.align || "left",
      ellipsis: true,
    });
    cx += col.width;
  }
  y += headerHeight;

  // Rows
  doc.fontSize(9);
  rows.forEach((row, rowIdx) => {
    // Zebra striping — every other row sky-50
    if (rowIdx % 2 === 1) {
      doc.rect(startX, y, totalWidth, rowHeight).fillColor("#F0F9FF").fill();
    }

    // Page break if we run out of room
    if (y + rowHeight > doc.page.height - 50) {
      doc.addPage();
      y = 50;
      // Repeat header on new page
      doc.rect(startX, y, totalWidth, headerHeight).fillColor(brand).fill();
      let hx = startX;
      doc.fontSize(9).fillColor("#ffffff");
      for (const col of cols) {
        doc.text(col.label, hx + 6, y + 7, {
          width: col.width - 12,
          align: col.align || "left",
          ellipsis: true,
        });
        hx += col.width;
      }
      y += headerHeight;
      doc.fontSize(9);
    }

    cx = startX;
    doc.fillColor(ink);
    for (let i = 0; i < cols.length; i++) {
      const col = cols[i];
      const val = row[i] ?? "";
      doc.text(String(val), cx + 6, y + 6, {
        width: col.width - 12,
        align: col.align || "left",
        ellipsis: true,
      });
      cx += col.width;
    }
    // Faint bottom border
    doc
      .moveTo(startX, y + rowHeight)
      .lineTo(startX + totalWidth, y + rowHeight)
      .strokeColor("#E0F2FE")
      .lineWidth(0.5)
      .stroke();
    y += rowHeight;
  });

  // Reset fillColor for anything drawn after the table
  doc.fillColor(muted);
  return y;
}
