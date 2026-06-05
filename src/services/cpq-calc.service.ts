// ============================================================================
// CPQ CALC SERVICE — Sprint 9
// ----------------------------------------------------------------------------
// THE single source of truth for quote line + total math. Reused by the quote
// service (create/update), the PDF generator, and the public quote page so the
// number a customer sees, the number on the PDF, and the number stored in the
// DB can never drift apart (acceptance #1).
//
// Math (matches the pre-Sprint-9 quote/deal-item engines exactly, so existing
// quotes stay byte-identical — acceptance #6):
//   gross        = qty × unitPrice
//   discount     = gross × discountPct/100
//   net          = gross − discount            (per line, pre-tax)
//   tax          = net × taxPct/100            (tax applies AFTER discount)
//   lineTotal    = net + tax                   (tax-inclusive line total)
// Totals: subtotal = Σ net, discountTotal = Σ discount, taxTotal = Σ tax,
//         grandTotal = subtotal + taxTotal. `subtotal` is NET of discount,
//         consistent with the stored quotes.subtotal column.
//
// Pure (no DB / no I/O) on purpose — price-book resolution & bundle expansion
// live in their own services and feed plain lines into here.
// ============================================================================

export interface CpqLine {
  quantity: number;
  unitPrice: number;
  discountPct?: number | null;
  taxPct?: number | null;
}

export interface CpqLineResult {
  /** qty × unitPrice, before discount */
  gross: number;
  /** discount amount on this line */
  discount: number;
  /** net = gross − discount (pre-tax) */
  net: number;
  /** tax on the net amount */
  tax: number;
  /** net + tax (tax-inclusive line total) */
  lineTotal: number;
}

export interface CpqTotals {
  subtotal: number; // Σ net (net of discount)
  discountTotal: number; // Σ discount
  taxTotal: number; // Σ tax
  grandTotal: number; // subtotal + taxTotal
}

export function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Compute the breakdown for a single line. */
export function computeLine(line: CpqLine): CpqLineResult {
  const qty = Number(line.quantity) || 0;
  const unit = Number(line.unitPrice) || 0;
  const discountPct = Number(line.discountPct) || 0;
  const taxPct = Number(line.taxPct) || 0;

  const gross = qty * unit;
  const discount = gross * (discountPct / 100);
  const net = gross - discount;
  const tax = net * (taxPct / 100);

  return {
    gross: round2(gross),
    discount: round2(discount),
    net: round2(net),
    tax: round2(tax),
    lineTotal: round2(net + tax),
  };
}

/** Aggregate totals across all lines. */
export function computeTotals(lines: CpqLine[]): CpqTotals {
  let subtotal = 0;
  let discountTotal = 0;
  let taxTotal = 0;

  for (const line of lines) {
    const qty = Number(line.quantity) || 0;
    const unit = Number(line.unitPrice) || 0;
    const gross = qty * unit;
    const discount = gross * ((Number(line.discountPct) || 0) / 100);
    const net = gross - discount;
    const tax = net * ((Number(line.taxPct) || 0) / 100);

    subtotal += net;
    discountTotal += discount;
    taxTotal += tax;
  }

  const sub = round2(subtotal);
  const taxT = round2(taxTotal);
  return {
    subtotal: sub,
    discountTotal: round2(discountTotal),
    taxTotal: taxT,
    grandTotal: round2(sub + taxT),
  };
}

/** Largest per-line discount % requested (used by discount governance). */
export function maxLineDiscountPct(lines: CpqLine[]): number {
  let max = 0;
  for (const line of lines) {
    const pct = Number(line.discountPct) || 0;
    if (pct > max) max = pct;
  }
  return round2(max);
}
