// ============================================================================
// ZATCA QR CODE ENCODER
// ----------------------------------------------------------------------------
// Saudi Arabia's ZATCA requires every invoice to carry a QR code with
// the seller's key details encoded in TLV (Tag-Length-Value) format,
// then Base64-encoded. This function builds that string so it can be
// rendered into a QR code image on receipts + invoice PDFs.
//
// TLV fields (required by spec for Phase 1 simplified invoices):
//   Tag 1 — Seller name (UTF-8)
//   Tag 2 — VAT registration number
//   Tag 3 — Invoice timestamp (ISO 8601 with offset)
//   Tag 4 — Invoice total (incl. VAT), plain decimal string
//   Tag 5 — VAT total, plain decimal string
//
// Phase 2 adds 3 more tags (invoice hash, ECDSA signature, public key)
// but those require the ZATCA-issued certificate which each merchant
// must obtain from the Fatoora portal. For now we build Phase 1 tags
// and leave hooks for Phase 2 fields to be populated once certs are
// provisioned.
//
// Reference: ZATCA E-Invoicing Implementation Guide v2.3 §3.4.4
// ============================================================================

interface ZatcaQrInput {
  sellerName: string;
  vatNumber: string;
  timestamp: Date;
  totalWithVat: number;
  vatTotal: number;
}

/**
 * Build a single TLV field as a Buffer:
 *   [tag (1 byte)] [length (1 byte)] [UTF-8 value bytes]
 */
function tlv(tag: number, value: string): Buffer {
  const valueBuf = Buffer.from(value, "utf8");
  if (valueBuf.length > 255) {
    throw new Error(`TLV value for tag ${tag} exceeds 255 bytes`);
  }
  const header = Buffer.from([tag, valueBuf.length]);
  return Buffer.concat([header, valueBuf]);
}

/**
 * Build the full ZATCA QR payload as a Base64 string.
 * Decimal values use '.' as the decimal separator and 2 decimal places,
 * matching the spec.
 */
export function buildZatcaQrCode(input: ZatcaQrInput): string {
  const parts = [
    tlv(1, input.sellerName),
    tlv(2, input.vatNumber),
    tlv(3, input.timestamp.toISOString()),
    tlv(4, input.totalWithVat.toFixed(2)),
    tlv(5, input.vatTotal.toFixed(2)),
  ];
  return Buffer.concat(parts).toString("base64");
}
