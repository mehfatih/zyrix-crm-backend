// ============================================================================
// PAYMENT COLLECTION GATEWAYS (Sprint 15E) — per-company keys, sandbox-first.
// ----------------------------------------------------------------------------
// Separate from the platform subscription gateways (which use global env keys).
// These take per-company sealed credentials as parameters and target merchant
// collection on quotes. iyzico = fully-hosted CheckoutForm; HyperPay = Copy&Pay
// (widget embedded on our public pay page). Reuses the iyzico HMAC scheme.
// ============================================================================

import { createHmac, randomUUID } from "crypto";

export type CollectProvider = "iyzico" | "hyperpay";

export interface IyzicoKeys { apiKey: string; secretKey: string }
export interface HyperPayKeys { entityId: string; accessToken: string }

const IYZICO_BASE = (sandbox: boolean) => (sandbox ? "https://sandbox-api.iyzipay.com" : "https://api.iyzipay.com");
const HYPERPAY_BASE = (sandbox: boolean) => (sandbox ? "https://test.oppwa.com" : "https://oppwa.com");

export interface InitInput {
  amount: number;
  currency: string;
  conversationId: string; // our payment_request id
  buyerEmail: string;
  buyerName: string;
  buyerCountry?: string;
  callbackUrl: string; // where the gateway returns the customer
}

export interface InitResult { externalId: string; checkoutUrl: string }

// ── iyzico HMAC auth (v1) ────────────────────────────────────────────────────
function iyzicoAuth(body: unknown, apiKey: string, secretKey: string) {
  const randomString = `${Date.now()}${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const payload = `${apiKey}${randomString}${secretKey}${JSON.stringify(body)}`;
  const hash = createHmac("sha256", secretKey).update(payload).digest("base64");
  return { authHeader: `IYZWS ${apiKey}:${hash}`, randomString };
}

export async function iyzicoInitialize(keys: IyzicoKeys, sandbox: boolean, input: InitInput): Promise<InitResult> {
  const [name, ...rest] = input.buyerName.trim().split(" ");
  const reqBody = {
    locale: "en",
    conversationId: input.conversationId,
    price: input.amount.toFixed(2),
    paidPrice: input.amount.toFixed(2),
    currency: input.currency,
    basketId: input.conversationId,
    paymentGroup: "PRODUCT",
    callbackUrl: input.callbackUrl,
    enabledInstallments: [1],
    buyer: {
      id: input.conversationId,
      name: name || input.buyerName,
      surname: rest.join(" ") || "-",
      email: input.buyerEmail,
      identityNumber: "11111111111",
      registrationAddress: "N/A",
      city: "N/A",
      country: input.buyerCountry || "Turkey",
      ip: "127.0.0.1",
    },
    shippingAddress: { contactName: input.buyerName, city: "N/A", country: input.buyerCountry || "Turkey", address: "N/A" },
    billingAddress: { contactName: input.buyerName, city: "N/A", country: input.buyerCountry || "Turkey", address: "N/A" },
    basketItems: [{ id: input.conversationId, name: "Quote payment", category1: "Quote", itemType: "VIRTUAL", price: input.amount.toFixed(2) }],
  };
  const endpoint = `${IYZICO_BASE(sandbox)}/payment/iyzipos/checkoutform/initialize/auth/ecom`;
  const { authHeader, randomString } = iyzicoAuth(reqBody, keys.apiKey, keys.secretKey);
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader, "x-iyzi-rnd": randomString },
    body: JSON.stringify(reqBody),
  });
  const data = (await resp.json()) as { status?: string; errorMessage?: string; token?: string; paymentPageUrl?: string };
  if (!resp.ok || data.status !== "success" || !data.paymentPageUrl) {
    throw new Error(`iyzico init failed: ${data.errorMessage ?? "unknown error"}`);
  }
  return { externalId: data.token ?? input.conversationId, checkoutUrl: data.paymentPageUrl };
}

// Verify by retrieving the CheckoutForm result for a token.
export async function iyzicoVerify(keys: IyzicoKeys, sandbox: boolean, token: string): Promise<{ paid: boolean; raw: unknown }> {
  const reqBody = { locale: "en", conversationId: token, token };
  const endpoint = `${IYZICO_BASE(sandbox)}/payment/iyzipos/checkoutform/auth/ecom/detail`;
  const { authHeader, randomString } = iyzicoAuth(reqBody, keys.apiKey, keys.secretKey);
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader, "x-iyzi-rnd": randomString },
    body: JSON.stringify(reqBody),
  });
  const data = (await resp.json()) as { status?: string; paymentStatus?: string };
  return { paid: data.status === "success" && data.paymentStatus === "SUCCESS", raw: data };
}

// ── HyperPay Copy&Pay ────────────────────────────────────────────────────────
const HP_OK = /^000\.\d{3}\.100$/;

export async function hyperpayInitialize(keys: HyperPayKeys, sandbox: boolean, input: InitInput): Promise<InitResult> {
  const body = new URLSearchParams();
  body.set("entityId", keys.entityId);
  body.set("amount", input.amount.toFixed(2));
  body.set("currency", input.currency);
  body.set("paymentType", "DB");
  body.set("merchantTransactionId", input.conversationId);
  body.set("customer.email", input.buyerEmail);
  body.set("customer.givenName", input.buyerName.split(" ")[0] || input.buyerName);
  body.set("customer.surname", input.buyerName.split(" ").slice(1).join(" ") || "-");
  const resp = await fetch(`${HYPERPAY_BASE(sandbox)}/v1/checkouts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${keys.accessToken}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = (await resp.json()) as { id?: string; result?: { code?: string; description?: string } };
  const code = data.result?.code ?? "";
  if (!resp.ok || !data.id || !(HP_OK.test(code) || code === "000.200.100")) {
    throw new Error(`HyperPay init failed: ${data.result?.description ?? "unknown error"}`);
  }
  // checkoutUrl points at OUR public pay page which embeds the OPPWA widget.
  return { externalId: data.id, checkoutUrl: input.callbackUrl };
}

// Query a checkout's payment status (called from the shopperResultUrl + status).
export async function hyperpayVerify(keys: HyperPayKeys, sandbox: boolean, checkoutId: string): Promise<{ paid: boolean; raw: unknown }> {
  const resp = await fetch(`${HYPERPAY_BASE(sandbox)}/v1/checkouts/${encodeURIComponent(checkoutId)}/payment?entityId=${encodeURIComponent(keys.entityId)}`, {
    headers: { Authorization: `Bearer ${keys.accessToken}` },
  });
  const data = (await resp.json()) as { result?: { code?: string } };
  const code = data.result?.code ?? "";
  return { paid: HP_OK.test(code) || code === "000.200.100", raw: data };
}

export function hyperpayWidgetBase(sandbox: boolean): string {
  return HYPERPAY_BASE(sandbox);
}
