// ============================================================================
// ZATCA XML SERIALIZER — UBL 2.1 compliant
// ----------------------------------------------------------------------------
// Generates the Invoice XML that ZATCA's platform accepts for clearance.
// Uses UBL 2.1 with ZATCA-specific extensions (InvoiceTypeCode name
// attribute, AdditionalDocumentReference for PIH/QR).
//
// This is a HAND-BUILT serializer rather than using a library because
// ZATCA validates XML whitespace + namespace declarations strictly,
// and a deps-driven approach would add risk. Entity escaping handles
// Arabic text correctly by relying on UTF-8 encoding.
//
// Reference: ZATCA E-Invoicing Implementation Standards v2.3 §7
// Sample validation tool: https://sandbox.zatca.gov.sa/Fatoora
// ============================================================================

import type { TaxInvoiceShape } from "./types";

function escapeXml(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Map our internal invoice type strings to ZATCA InvoiceTypeCode values:
 *   '388' = Tax invoice (standard)
 *   '383' = Debit note
 *   '381' = Credit note
 *
 * The `name` attribute on InvoiceTypeCode is a 4-char bitmask where
 * position 0 = B2B (1) or B2C (0), positions 1-3 are document type
 * flags. Standard B2B tax invoice → '0100'. Simplified B2C → '0200'.
 */
function invoiceTypeCode(type: string): { code: string; name: string } {
  if (type === "simplified") return { code: "388", name: "0200" };
  if (type === "credit_note") return { code: "381", name: "0100" };
  if (type === "debit_note") return { code: "383", name: "0100" };
  return { code: "388", name: "0100" }; // standard tax invoice
}

export interface ZatcaXmlInput extends TaxInvoiceShape {
  qrCode?: string;
  previousInvoiceHash?: string;
}

export function buildZatcaXml(inv: ZatcaXmlInput): string {
  const typeInfo = invoiceTypeCode(inv.type);
  const issuedIso = inv.issuedAt.toISOString();
  const issuedDate = issuedIso.slice(0, 10); // YYYY-MM-DD
  const issuedTime = issuedIso.slice(11, 19); // HH:mm:ss

  const items = Array.isArray(inv.lineItems) ? inv.lineItems : [];

  const lineElements = items
    .map((item: any, idx: number) => {
      const quantity = Number(item.quantity ?? 1);
      const unitPrice = Number(item.unitPrice ?? 0);
      const lineTotal = Number(item.lineTotal ?? quantity * unitPrice);
      const taxRate = Number(item.taxRate ?? inv.taxRate);
      const taxAmount = (lineTotal * taxRate) / 100;
      return `
  <cac:InvoiceLine>
    <cbc:ID>${idx + 1}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="PCE">${quantity.toFixed(2)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${escapeXml(inv.currency)}">${lineTotal.toFixed(2)}</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="${escapeXml(inv.currency)}">${taxAmount.toFixed(2)}</cbc:TaxAmount>
      <cbc:RoundingAmount currencyID="${escapeXml(inv.currency)}">${(lineTotal + taxAmount).toFixed(2)}</cbc:RoundingAmount>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Name>${escapeXml(item.description ?? "Item")}</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>${taxRate.toFixed(2)}</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${escapeXml(inv.currency)}">${unitPrice.toFixed(2)}</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
         xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>${escapeXml(inv.invoiceNumber)}</cbc:ID>
  <cbc:UUID>${escapeXml(inv.id)}</cbc:UUID>
  <cbc:IssueDate>${issuedDate}</cbc:IssueDate>
  <cbc:IssueTime>${issuedTime}</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="${typeInfo.name}">${typeInfo.code}</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${escapeXml(inv.currency)}</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>${escapeXml(inv.currency)}</cbc:TaxCurrencyCode>
  ${inv.previousInvoiceHash ? `
  <cac:AdditionalDocumentReference>
    <cbc:ID>PIH</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${escapeXml(inv.previousInvoiceHash)}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>` : ""}
  ${inv.qrCode ? `
  <cac:AdditionalDocumentReference>
    <cbc:ID>QR</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${escapeXml(inv.qrCode)}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>` : ""}
  <cac:AccountingSupplierParty>
    <cac:Party>
      ${inv.sellerVatNo ? `
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${escapeXml(inv.sellerVatNo)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>` : ""}
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${escapeXml(inv.sellerName)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
      ${inv.sellerAddress ? `
      <cac:PostalAddress>
        <cbc:StreetName>${escapeXml(inv.sellerAddress)}</cbc:StreetName>
        <cac:Country><cbc:IdentificationCode>SA</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>` : ""}
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      ${inv.buyerVatNo ? `
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${escapeXml(inv.buyerVatNo)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>` : ""}
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${escapeXml(inv.buyerName)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${escapeXml(inv.currency)}">${Number(inv.taxAmount).toFixed(2)}</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${escapeXml(inv.currency)}">${Number(inv.subtotal).toFixed(2)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${escapeXml(inv.currency)}">${Number(inv.subtotal).toFixed(2)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${escapeXml(inv.currency)}">${Number(inv.totalAmount).toFixed(2)}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="${escapeXml(inv.currency)}">${Number(inv.discountAmount).toFixed(2)}</cbc:AllowanceTotalAmount>
    <cbc:PayableAmount currencyID="${escapeXml(inv.currency)}">${Number(inv.totalAmount).toFixed(2)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>${lineElements}
</Invoice>`;
}
