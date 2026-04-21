// ============================================================================
// TURKEY e-FATURA / e-ARŞİV XML SERIALIZER — UBL-TR 1.2 compliant
// ----------------------------------------------------------------------------
// Generates the Invoice XML that Turkey's GIB (Gelir İdaresi Başkanlığı)
// requires for B2B (e-Fatura) and B2C (e-Arşiv) electronic invoicing.
//
// Key differences from generic UBL:
//   • ProfileID 'TEMELFATURA' (basic) or 'TICARIFATURA' (commercial)
//   • ProfileID 'EARSIVFATURA' for e-Arşiv (B2C)
//   • Customization ID 'TR1.2' required
//   • Buyer tax ID is TCKN (11 digits for individuals) or VKN (10 digits
//     for legal entities); exactly one must be set. We use a heuristic:
//     if buyerVatNo length is 11, treat as TCKN, else VKN.
//   • Currency is always TRY for domestic; foreign invoices need
//     PricingExchangeRate element (not implemented — out of scope)
//
// Reference: GIB e-Fatura Uygulaması Gelir İdaresi Başkanlığı v1.2
// Source for reference XMLs: efatura.gov.tr/download/paket/
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
 * Pick the right TR customer-ID element based on length:
 *   TCKN (11 digits) → individual
 *   VKN (10 digits)  → legal entity
 */
function buyerIdElement(vatNo: string | null | undefined): string {
  if (!vatNo) return "";
  const clean = vatNo.replace(/\s/g, "");
  if (clean.length === 11) {
    return `<cbc:SchemeID>TCKN</cbc:SchemeID><cbc:ID>${escapeXml(clean)}</cbc:ID>`;
  }
  return `<cbc:SchemeID>VKN</cbc:SchemeID><cbc:ID>${escapeXml(clean)}</cbc:ID>`;
}

export interface TurkeyXmlInput extends TaxInvoiceShape {
  regime: "efatura" | "earsiv";
}

function profileId(regime: "efatura" | "earsiv"): string {
  if (regime === "earsiv") return "EARSIVFATURA";
  return "TEMELFATURA";
}

export function buildTurkeyXml(inv: TurkeyXmlInput): string {
  const issuedIso = inv.issuedAt.toISOString();
  const issuedDate = issuedIso.slice(0, 10);
  const issuedTime = issuedIso.slice(11, 19);
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
    <cbc:InvoicedQuantity unitCode="C62">${quantity.toFixed(2)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${escapeXml(inv.currency)}">${lineTotal.toFixed(2)}</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="${escapeXml(inv.currency)}">${taxAmount.toFixed(2)}</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="${escapeXml(inv.currency)}">${lineTotal.toFixed(2)}</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="${escapeXml(inv.currency)}">${taxAmount.toFixed(2)}</cbc:TaxAmount>
        <cbc:Percent>${taxRate.toFixed(2)}</cbc:Percent>
        <cac:TaxCategory>
          <cac:TaxScheme>
            <cbc:Name>KDV</cbc:Name>
            <cbc:TaxTypeCode>0015</cbc:TaxTypeCode>
          </cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Name>${escapeXml(item.description ?? "Ürün")}</cbc:Name>
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
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>TR1.2</cbc:CustomizationID>
  <cbc:ProfileID>${profileId(inv.regime)}</cbc:ProfileID>
  <cbc:ID>${escapeXml(inv.invoiceNumber)}</cbc:ID>
  <cbc:UUID>${escapeXml(inv.id)}</cbc:UUID>
  <cbc:IssueDate>${issuedDate}</cbc:IssueDate>
  <cbc:IssueTime>${issuedTime}</cbc:IssueTime>
  <cbc:InvoiceTypeCode>SATIS</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${escapeXml(inv.currency)}</cbc:DocumentCurrencyCode>
  <cbc:LineCountNumeric>${items.length}</cbc:LineCountNumeric>
  <cac:AccountingSupplierParty>
    <cac:Party>
      ${inv.sellerVatNo ? `
      <cac:PartyIdentification>
        <cbc:ID schemeID="VKN">${escapeXml(inv.sellerVatNo)}</cbc:ID>
      </cac:PartyIdentification>` : ""}
      <cac:PartyName>
        <cbc:Name>${escapeXml(inv.sellerName)}</cbc:Name>
      </cac:PartyName>
      ${inv.sellerAddress ? `
      <cac:PostalAddress>
        <cbc:StreetName>${escapeXml(inv.sellerAddress)}</cbc:StreetName>
        <cac:Country><cbc:Name>Türkiye</cbc:Name></cac:Country>
      </cac:PostalAddress>` : ""}
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      ${inv.buyerVatNo ? `
      <cac:PartyIdentification>
        ${buyerIdElement(inv.buyerVatNo)}
      </cac:PartyIdentification>` : ""}
      <cac:PartyName>
        <cbc:Name>${escapeXml(inv.buyerName)}</cbc:Name>
      </cac:PartyName>
      ${inv.buyerAddress ? `
      <cac:PostalAddress>
        <cbc:StreetName>${escapeXml(inv.buyerAddress)}</cbc:StreetName>
        <cac:Country><cbc:Name>Türkiye</cbc:Name></cac:Country>
      </cac:PostalAddress>` : ""}
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${escapeXml(inv.currency)}">${Number(inv.taxAmount).toFixed(2)}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${escapeXml(inv.currency)}">${Number(inv.subtotal).toFixed(2)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${escapeXml(inv.currency)}">${Number(inv.taxAmount).toFixed(2)}</cbc:TaxAmount>
      <cbc:Percent>${Number(inv.taxRate).toFixed(2)}</cbc:Percent>
      <cac:TaxCategory>
        <cac:TaxScheme>
          <cbc:Name>KDV</cbc:Name>
          <cbc:TaxTypeCode>0015</cbc:TaxTypeCode>
        </cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
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
