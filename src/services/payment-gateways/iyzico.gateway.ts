import { createHmac, randomUUID } from "crypto";
import { env } from "../../config/env";
import type {
  CheckoutSessionInput,
  CheckoutSessionResult,
  PaymentGateway,
  SupportedCurrency,
  WebhookEvent,
} from "./gateway.interface";

// ============================================================================
// IYZICO GATEWAY (Turkey)
// ============================================================================
// Uses Iyzico Checkout Form API (hosted checkout). Webhooks arrive on
// /api/webhooks/iyzico signed with HMAC-SHA256 using the secret key.
//
// NOTE: When IYZICO_API_KEY / IYZICO_SECRET_KEY are missing, this gateway
// operates in a stub mode that still returns a valid CheckoutSessionResult
// pointing at an internal mock confirmation page. This keeps dev + QA flowing
// while real credentials are being provisioned on Railway.
// ============================================================================

const SUPPORTED: SupportedCurrency[] = ["TRY", "USD"];

export class IyzicoGateway implements PaymentGateway {
  readonly name = "iyzico" as const;

  isAvailable(): boolean {
    return Boolean(env.IYZICO_API_KEY && env.IYZICO_SECRET_KEY);
  }

  async createCheckoutSession(
    input: CheckoutSessionInput
  ): Promise<CheckoutSessionResult> {
    if (!SUPPORTED.includes(input.currency)) {
      throw new Error(
        `Iyzico does not support currency ${input.currency}. Use TRY or USD.`
      );
    }

    // Stub mode: no credentials configured — emit a deterministic session
    if (!this.isAvailable()) {
      return buildStubSession(input, "iyzico");
    }

    // Real mode — Iyzico Checkout Form initialize
    // https://dev.iyzipay.com/en/api/checkout-form
    const reqBody = {
      locale: "en",
      conversationId: input.clientReference,
      price: input.amount.toFixed(2),
      paidPrice: input.amount.toFixed(2),
      currency: input.currency,
      basketId: input.clientReference,
      paymentGroup: "SUBSCRIPTION",
      callbackUrl: input.successUrl,
      buyer: {
        id: input.companyId,
        name: input.buyerFullName.split(" ")[0] || input.buyerFullName,
        surname: input.buyerFullName.split(" ").slice(1).join(" ") || "—",
        gsmNumber: input.buyerPhone ?? "+905555555555",
        email: input.buyerEmail,
        identityNumber: "11111111111",
        registrationAddress: "—",
        city: "Istanbul",
        country: input.buyerCountry || "Turkey",
        ip: input.buyerIp ?? "127.0.0.1",
      },
      shippingAddress: {
        contactName: input.buyerFullName,
        city: "Istanbul",
        country: input.buyerCountry || "Turkey",
        address: "—",
      },
      billingAddress: {
        contactName: input.buyerFullName,
        city: "Istanbul",
        country: input.buyerCountry || "Turkey",
        address: "—",
      },
      basketItems: [
        {
          id: input.planSlug,
          name: `Zyrix ${input.planSlug} (${input.billingCycle})`,
          category1: "Subscription",
          itemType: "VIRTUAL",
          price: input.amount.toFixed(2),
        },
      ],
    };

    const endpoint = `${env.IYZICO_BASE_URL}/payment/iyzipos/checkoutform/initialize/auth/ecom`;
    const { authHeader, randomString } = buildIyzicoAuthHeader(
      reqBody,
      env.IYZICO_API_KEY as string,
      env.IYZICO_SECRET_KEY as string
    );

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
        "x-iyzi-rnd": randomString,
      },
      body: JSON.stringify(reqBody),
    });

    const data = (await response.json()) as {
      status?: string;
      errorMessage?: string;
      token?: string;
      paymentPageUrl?: string;
    };

    if (!response.ok || data.status !== "success") {
      throw new Error(
        `Iyzico init failed: ${data.errorMessage ?? "unknown error"}`
      );
    }

    return {
      gatewaySessionId: data.token ?? input.clientReference,
      redirectUrl: data.paymentPageUrl ?? input.successUrl,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    };
  }

  parseWebhook(body: unknown, headers: Record<string, string>): WebhookEvent {
    // Iyzico webhook verification: X-IYZ-SIGNATURE header contains HMAC-SHA256
    // of raw body using IYZICO_SECRET_KEY.
    const secret = env.IYZICO_SECRET_KEY;
    const signature =
      headers["x-iyz-signature"] ||
      headers["X-IYZ-SIGNATURE"] ||
      headers["X-Iyz-Signature"];

    if (secret && signature) {
      const raw =
        typeof body === "string" ? body : JSON.stringify(body);
      const expected = createHmac("sha256", secret).update(raw).digest("hex");
      if (expected !== signature) {
        throw new Error("Iyzico webhook signature mismatch");
      }
    }

    const payload = (body ?? {}) as {
      iyziEventType?: string;
      paymentConversationId?: string;
      token?: string;
      paymentId?: string;
      price?: string;
      paidPrice?: string;
      currency?: string;
      status?: string;
      paymentMethod?: string;
      lastFourDigits?: string;
      cardAssociation?: string;
      errorMessage?: string;
    };

    let type: WebhookEvent["type"] = "unknown";
    const eventType = (payload.iyziEventType ?? payload.status ?? "").toLowerCase();
    if (eventType.includes("success") || eventType.includes("auth"))
      type = "payment.succeeded";
    else if (eventType.includes("fail") || eventType.includes("decline"))
      type = "payment.failed";
    else if (eventType.includes("refund")) type = "payment.refunded";

    return {
      type,
      raw: body,
      gatewayPaymentId: payload.paymentId ?? null,
      gatewaySessionId: payload.token ?? null,
      clientReference: payload.paymentConversationId ?? null,
      amount: payload.paidPrice ? Number(payload.paidPrice) : null,
      currency: (payload.currency as SupportedCurrency) ?? null,
      method: payload.paymentMethod ?? null,
      last4: payload.lastFourDigits ?? null,
      cardBrand: payload.cardAssociation ?? null,
      failureReason: payload.errorMessage ?? null,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build the Iyzico Authorization header (v1 HMAC scheme).
 * https://dev.iyzipay.com/en/api/authentication
 */
function buildIyzicoAuthHeader(
  body: unknown,
  apiKey: string,
  secretKey: string
): { authHeader: string; randomString: string } {
  const randomString = `${Date.now()}${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const payload = `${apiKey}${randomString}${secretKey}${JSON.stringify(body)}`;
  const hash = createHmac("sha256", secretKey)
    .update(payload)
    .digest("base64");
  return {
    authHeader: `IYZWS ${apiKey}:${hash}`,
    randomString,
  };
}

/**
 * Development stub — no Iyzico credentials configured.
 * Returns a URL that points to our internal mock confirmation endpoint.
 */
function buildStubSession(
  input: CheckoutSessionInput,
  gateway: "iyzico" | "hyperpay"
): CheckoutSessionResult {
  const stubUrl = new URL(input.successUrl);
  stubUrl.searchParams.set("stub", "1");
  stubUrl.searchParams.set("gateway", gateway);
  stubUrl.searchParams.set("ref", input.clientReference);
  return {
    gatewaySessionId: `stub_${input.clientReference}`,
    redirectUrl: stubUrl.toString(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  };
}
