// ============================================================================
// COMPLIANCE SHARED TYPES
// ----------------------------------------------------------------------------
// Common shape used by both ZATCA + Turkey serializers so the main
// tax-invoice service can call either without caring which one.
// ============================================================================

export interface TaxInvoiceShape {
  id: string;
  companyId: string;
  regime: string;
  type: string;
  invoiceNumber: string;

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
  lineItems: unknown; // JSON payload, shape:
  //   Array<{ description, quantity, unitPrice, discount?, taxRate?, lineTotal }>

  issuedAt: Date;
}
