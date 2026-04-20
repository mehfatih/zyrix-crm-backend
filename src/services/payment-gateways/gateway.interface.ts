// ============================================================================
// PAYMENT GATEWAY INTERFACE
// ============================================================================
// Pluggable contract for payment gateways. Each gateway (Iyzico for Turkey,
// HyperPay for MENA) implements this interface. Callers select a gateway via
// the country → gateway routing rules in payment.service.ts.
// ============================================================================

export type SupportedCurrency = "USD" | "TRY" | "SAR" | "AED";
export type BillingCycle = "monthly" | "yearly";

export interface CheckoutSessionInput {
  // What the customer is buying
  companyId: string;
  planSlug: string;
  billingCycle: BillingCycle;
  currency: SupportedCurrency;
  amount: number; // integer minor units? NO — decimal major units. Gateway adapts.

  // Who the customer is
  buyerEmail: string;
  buyerFullName: string;
  buyerPhone?: string | null;
  buyerCountry: string;
  buyerIp?: string | null;

  // URLs the gateway redirects to
  successUrl: string;
  cancelUrl: string;

  // Opaque reference this service stores to later match webhook → session
  clientReference: string;
}

export interface CheckoutSessionResult {
  // Gateway-side reference (used for webhook reconciliation)
  gatewaySessionId: string;

  // Redirect the browser here — gateway hosted checkout
  redirectUrl: string;

  // When this session expires (usually ~30 min from creation)
  expiresAt: Date;
}

export interface WebhookEvent {
  // Normalized across gateways
  type: "payment.succeeded" | "payment.failed" | "payment.refunded" | "unknown";

  // Gateway raw payload for audit
  raw: unknown;

  // Parsed fields (populated when recognizable)
  gatewayPaymentId: string | null;
  gatewaySessionId: string | null;
  clientReference: string | null;
  amount: number | null;
  currency: SupportedCurrency | null;
  method: string | null;
  last4: string | null;
  cardBrand: string | null;
  failureReason: string | null;
}

export interface PaymentGateway {
  readonly name: "iyzico" | "hyperpay";

  /**
   * Whether this gateway is configured with valid credentials.
   * If false, callers should 503 gracefully.
   */
  isAvailable(): boolean;

  /**
   * Create a hosted checkout session. Returns a URL to redirect the browser to.
   */
  createCheckoutSession(
    input: CheckoutSessionInput
  ): Promise<CheckoutSessionResult>;

  /**
   * Verify and parse a raw webhook body + headers. Throws if signature is invalid.
   */
  parseWebhook(body: unknown, headers: Record<string, string>): WebhookEvent;
}
