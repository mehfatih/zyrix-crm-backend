import { env } from "../../config/env";
import type {
  CheckoutSessionInput,
  CheckoutSessionResult,
  PaymentGateway,
  SupportedCurrency,
  WebhookEvent,
} from "./gateway.interface";

// ============================================================================
// HYPERPAY GATEWAY (MENA — Saudi Arabia, UAE, GCC)
// ============================================================================
// Uses HyperPay COPYandPAY Checkout (server-to-server session creation,
// then hosted payment widget). Webhooks arrive on /api/webhooks/hyperpay.
//
// Reference: https://hyperpay.docs.oppwa.com/tutorials/server-to-server
// ============================================================================

const SUPPORTED: SupportedCurrency[] = ["SAR", "AED", "USD"];

export class HyperPayGateway implements PaymentGateway {
  readonly name = "hyperpay" as const;

  isAvailable(): boolean {
    return Boolean(env.HYPERPAY_ACCESS_TOKEN && env.HYPERPAY_ENTITY_ID);
  }

  async createCheckoutSession(
    input: CheckoutSessionInput
  ): Promise<CheckoutSessionResult> {
    if (!SUPPORTED.includes(input.currency)) {
      throw new Error(
        `HyperPay does not support currency ${input.currency}. Use SAR, AED, or USD.`
      );
    }

    if (!this.isAvailable()) {
      return buildStubSession(input);
    }

    // POST /v1/checkouts with form-encoded body
    const body = new URLSearchParams();
    body.set("entityId", env.HYPERPAY_ENTITY_ID as string);
    body.set("amount", input.amount.toFixed(2));
    body.set("currency", input.currency);
    body.set("paymentType", "DB"); // DB = debit (auth + capture)
    body.set("merchantTransactionId", input.clientReference);
    body.set("customer.email", input.buyerEmail);
    body.set("customer.givenName", input.buyerFullName.split(" ")[0] || input.buyerFullName);
    body.set(
      "customer.surname",
      input.buyerFullName.split(" ").slice(1).join(" ") || "—"
    );
    if (input.buyerPhone) body.set("customer.phone", input.buyerPhone);
    body.set("billing.country", countryAlpha2(input.buyerCountry));
    body.set("shopperResultUrl", input.successUrl);

    const endpoint = `${env.HYPERPAY_BASE_URL}/v1/checkouts`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.HYPERPAY_ACCESS_TOKEN}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    const data = (await response.json()) as {
      id?: string;
      result?: { code?: string; description?: string };
    };

    const code = data.result?.code ?? "";
    // HyperPay success codes: 000.200.100 or regex 000.\d{3}.100
    const ok = /^000\.\d{3}\.100$/.test(code) || code === "000.200.100";
    if (!response.ok || !data.id || !ok) {
      throw new Error(
        `HyperPay init failed: ${data.result?.description ?? "unknown error"}`
      );
    }

    // The widget URL format for OPPWA hosted checkout
    const widgetUrl = `${env.HYPERPAY_BASE_URL}/v1/paymentWidgets.js?checkoutId=${data.id}`;

    // We redirect to OUR own page which embeds the widget, passing the
    // checkout id and widget URL as query params.
    const redirectUrl = new URL(input.successUrl);
    redirectUrl.searchParams.set("checkoutId", data.id);
    redirectUrl.searchParams.set("widgetUrl", widgetUrl);
    redirectUrl.searchParams.set("gateway", "hyperpay");

    return {
      gatewaySessionId: data.id,
      redirectUrl: redirectUrl.toString(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    };
  }

  parseWebhook(body: unknown, _headers: Record<string, string>): WebhookEvent {
    // HyperPay webhooks arrive as JSON payloads (already decrypted when
    // public-key webhook decryption is OFF — sandbox default).
    // In production enable webhook encryption and decrypt with HYPERPAY_WEBHOOK_KEY.

    const payload = (body ?? {}) as {
      type?: string;
      payload?: {
        id?: string;
        merchantTransactionId?: string;
        amount?: string;
        currency?: string;
        paymentBrand?: string;
        paymentType?: string;
        result?: { code?: string; description?: string };
        card?: { last4Digits?: string };
      };
    };

    const inner = payload.payload ?? {};
    const code = inner.result?.code ?? "";
    const success = /^000\.\d{3}\.100$/.test(code) || code === "000.200.100";
    const pending = /^000\.200/.test(code);
    const refund = inner.paymentType === "RF" || inner.paymentType === "RV";

    let type: WebhookEvent["type"] = "unknown";
    if (refund) type = "payment.refunded";
    else if (success) type = "payment.succeeded";
    else if (!success && !pending) type = "payment.failed";

    return {
      type,
      raw: body,
      gatewayPaymentId: inner.id ?? null,
      gatewaySessionId: null,
      clientReference: inner.merchantTransactionId ?? null,
      amount: inner.amount ? Number(inner.amount) : null,
      currency: (inner.currency as SupportedCurrency) ?? null,
      method: inner.paymentType ?? null,
      last4: inner.card?.last4Digits ?? null,
      cardBrand: inner.paymentBrand ?? null,
      failureReason:
        type === "payment.failed"
          ? inner.result?.description ?? null
          : null,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function countryAlpha2(input: string): string {
  const c = (input || "").trim();
  if (c.length === 2) return c.toUpperCase();
  const map: Record<string, string> = {
    "saudi arabia": "SA",
    saudi: "SA",
    ksa: "SA",
    "united arab emirates": "AE",
    uae: "AE",
    turkey: "TR",
    türkiye: "TR",
    turkiye: "TR",
    egypt: "EG",
    iraq: "IQ",
    kuwait: "KW",
    qatar: "QA",
    bahrain: "BH",
    oman: "OM",
  };
  return map[c.toLowerCase()] ?? "SA";
}

function buildStubSession(input: CheckoutSessionInput): CheckoutSessionResult {
  const stubUrl = new URL(input.successUrl);
  stubUrl.searchParams.set("stub", "1");
  stubUrl.searchParams.set("gateway", "hyperpay");
  stubUrl.searchParams.set("ref", input.clientReference);
  return {
    gatewaySessionId: `stub_${input.clientReference}`,
    redirectUrl: stubUrl.toString(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  };
}
