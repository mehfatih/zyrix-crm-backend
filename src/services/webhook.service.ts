import crypto from "crypto";
import { prisma } from "../config/database";
import { AppError, notFound } from "../middleware/errorHandler";
import { upsertShopCustomer } from "./ecommerce.service";

// ============================================================================
// WEBHOOKS — inbound receivers for Shopify, Salla, Zid, etc.
//
// Flow:
//   1. Platform POSTs to /api/webhooks/:platform/:companyId
//   2. verifyAndRecord() reads the raw body (bodyParser middleware set up in
//      routes), looks up the matching WebhookSubscription for the topic,
//      verifies HMAC with that subscription's secret, persists the raw payload
//      to webhook_events (signatureOk flag records the verification outcome),
//      and returns the event row.
//   3. processEvent() is invoked best-effort; failures are logged to the row
//      but never fail the HTTP response (platforms retry on non-2xx).
// ============================================================================

export const SUPPORTED_PLATFORMS = [
  "shopify",
  "salla",
  "zid",
  "woocommerce",
  "youcan",
] as const;

export type WebhookPlatform = (typeof SUPPORTED_PLATFORMS)[number];

// Each platform tells us where to find the HMAC and how it's computed.
interface PlatformVerifier {
  /** HTTP header containing the signature */
  signatureHeader: string;
  /** hex | base64 */
  encoding: "hex" | "base64";
  /** Algorithm for HMAC */
  algorithm: "sha256";
  /** Header carrying the event topic (optional — falls back to body lookup) */
  topicHeader?: string;
  /** Header carrying a platform-side unique id (optional) */
  idHeader?: string;
  /** Default topic when header missing (e.g. WooCommerce resource/event combo) */
  topicFromBody?: (json: any) => string | null;
}

const VERIFIERS: Record<WebhookPlatform, PlatformVerifier> = {
  shopify: {
    signatureHeader: "x-shopify-hmac-sha256",
    encoding: "base64",
    algorithm: "sha256",
    topicHeader: "x-shopify-topic",
    idHeader: "x-shopify-webhook-id",
  },
  salla: {
    // Salla signs with HMAC-SHA256 hex in X-Salla-Signature
    signatureHeader: "x-salla-signature",
    encoding: "hex",
    algorithm: "sha256",
    topicHeader: "x-salla-event",
  },
  zid: {
    signatureHeader: "x-zid-signature",
    encoding: "hex",
    algorithm: "sha256",
    topicHeader: "x-zid-event",
  },
  woocommerce: {
    signatureHeader: "x-wc-webhook-signature",
    encoding: "base64",
    algorithm: "sha256",
    topicHeader: "x-wc-webhook-topic",
    idHeader: "x-wc-webhook-id",
  },
  youcan: {
    signatureHeader: "x-youcan-signature",
    encoding: "hex",
    algorithm: "sha256",
    topicHeader: "x-youcan-event",
    topicFromBody: (b) => (typeof b?.event === "string" ? b.event : null),
  },
};

// ──────────────────────────────────────────────────────────────────────
// SUBSCRIPTION CRUD
// ──────────────────────────────────────────────────────────────────────

export function isSupportedPlatform(p: string): p is WebhookPlatform {
  return (SUPPORTED_PLATFORMS as readonly string[]).includes(p);
}

export function getPublicUrl(
  platform: string,
  companyId: string,
  baseUrl: string
): string {
  const base = baseUrl.replace(/\/$/, "");
  return `${base}/api/webhooks/${platform}/${companyId}`;
}

export async function listSubscriptions(companyId: string, storeId?: string) {
  return prisma.webhookSubscription.findMany({
    where: { companyId, ...(storeId ? { storeId } : {}) },
    orderBy: [{ platform: "asc" }, { topic: "asc" }],
    select: {
      id: true,
      platform: true,
      storeId: true,
      topic: true,
      isActive: true,
      lastReceivedAt: true,
      receivedCount: true,
      failedCount: true,
      createdAt: true,
      updatedAt: true,
      // secret intentionally omitted — only returned from create/rotate
    },
  });
}

export async function createSubscription(
  companyId: string,
  input: {
    platform: string;
    topic: string;
    storeId?: string | null;
  }
) {
  if (!isSupportedPlatform(input.platform)) {
    throw new AppError(`Unsupported platform: ${input.platform}`, 400, "BAD_REQUEST");
  }
  const secret = crypto.randomBytes(32).toString("hex");
  const sub = await prisma.webhookSubscription.create({
    data: {
      companyId,
      platform: input.platform,
      topic: input.topic.toLowerCase().trim(),
      storeId: input.storeId ?? null,
      secret,
      isActive: true,
    },
  });
  return sub; // secret returned exactly once
}

export async function rotateSecret(companyId: string, subscriptionId: string) {
  const existing = await prisma.webhookSubscription.findFirst({
    where: { id: subscriptionId, companyId },
    select: { id: true },
  });
  if (!existing) throw notFound("Webhook subscription not found");
  const secret = crypto.randomBytes(32).toString("hex");
  return prisma.webhookSubscription.update({
    where: { id: existing.id },
    data: { secret },
  });
}

export async function setActive(
  companyId: string,
  subscriptionId: string,
  isActive: boolean
) {
  const existing = await prisma.webhookSubscription.findFirst({
    where: { id: subscriptionId, companyId },
    select: { id: true },
  });
  if (!existing) throw notFound("Webhook subscription not found");
  return prisma.webhookSubscription.update({
    where: { id: existing.id },
    data: { isActive },
    select: {
      id: true,
      platform: true,
      topic: true,
      storeId: true,
      isActive: true,
      lastReceivedAt: true,
      receivedCount: true,
      failedCount: true,
    },
  });
}

export async function deleteSubscription(
  companyId: string,
  subscriptionId: string
) {
  const existing = await prisma.webhookSubscription.findFirst({
    where: { id: subscriptionId, companyId },
    select: { id: true },
  });
  if (!existing) throw notFound("Webhook subscription not found");
  await prisma.webhookSubscription.delete({ where: { id: existing.id } });
  return { deleted: true };
}

export async function listRecentEvents(
  companyId: string,
  limit = 50,
  platform?: string,
  status?: string
) {
  return prisma.webhookEvent.findMany({
    where: {
      companyId,
      ...(platform ? { platform } : {}),
      ...(status ? { status } : {}),
    },
    orderBy: { receivedAt: "desc" },
    take: Math.min(limit, 200),
    select: {
      id: true,
      platform: true,
      topic: true,
      externalId: true,
      status: true,
      attempts: true,
      lastError: true,
      signatureOk: true,
      receivedAt: true,
      processedAt: true,
    },
  });
}

// ──────────────────────────────────────────────────────────────────────
// VERIFY + RECORD
// ──────────────────────────────────────────────────────────────────────

/**
 * Constant-time HMAC comparison.
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function computeSignature(
  raw: Buffer,
  secret: string,
  encoding: "hex" | "base64"
): string {
  return crypto
    .createHmac("sha256", secret)
    .update(raw)
    .digest(encoding);
}

interface VerifyOutcome {
  eventId: string;
  subscriptionId: string | null;
  signatureOk: boolean;
  topic: string;
  companyId: string;
  platform: string;
  payloadJson: any;
}

/**
 * Verify the inbound signature, pick the right subscription, persist the event.
 * Returns the created event row so the controller can decide on HTTP status and
 * processEvent() can run it.
 */
export async function verifyAndRecord(params: {
  platform: string;
  companyId: string;
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}): Promise<VerifyOutcome> {
  const { platform, companyId, rawBody, headers } = params;

  if (!isSupportedPlatform(platform)) {
    throw new AppError(`Unsupported webhook platform: ${platform}`, 400, "BAD_REQUEST");
  }
  const verifier = VERIFIERS[platform];

  const header = (k: string): string | null => {
    const v = headers[k.toLowerCase()];
    if (Array.isArray(v)) return v[0] ?? null;
    return typeof v === "string" ? v : null;
  };

  const sigHeader = header(verifier.signatureHeader);
  let payloadJson: any = {};
  try {
    payloadJson = JSON.parse(rawBody.toString("utf8") || "{}");
  } catch {
    payloadJson = { __parseError: true };
  }

  // Topic resolution: prefer header, fall back to body-derived, else "unknown"
  const topic =
    (verifier.topicHeader ? header(verifier.topicHeader) : null) ||
    (verifier.topicFromBody ? verifier.topicFromBody(payloadJson) : null) ||
    "unknown";

  const externalId = verifier.idHeader ? header(verifier.idHeader) : null;

  // Find the active subscription for this topic. If multiple exist, prefer the
  // one whose secret verifies — multiple stores may register the same topic.
  const candidates = await prisma.webhookSubscription.findMany({
    where: {
      companyId,
      platform,
      topic,
      isActive: true,
    },
    select: { id: true, secret: true },
  });

  let matchedSubId: string | null = null;
  let signatureOk = false;

  if (sigHeader && candidates.length > 0) {
    const expected = candidates.map((c) => ({
      id: c.id,
      sig: computeSignature(rawBody, c.secret, verifier.encoding),
    }));
    const hit = expected.find((e) => timingSafeEqualStr(e.sig, sigHeader));
    if (hit) {
      matchedSubId = hit.id;
      signatureOk = true;
    }
  }

  const event = await prisma.webhookEvent.create({
    data: {
      companyId,
      subscriptionId: matchedSubId,
      platform,
      topic,
      externalId: externalId || null,
      status: signatureOk ? "pending" : "skipped",
      payloadRaw: rawBody.toString("utf8"),
      payloadJson,
      signatureOk,
      lastError: signatureOk ? null : "HMAC verification failed or no matching subscription",
    },
  });

  if (matchedSubId) {
    await prisma.webhookSubscription.update({
      where: { id: matchedSubId },
      data: {
        lastReceivedAt: new Date(),
        receivedCount: { increment: 1 },
        ...(signatureOk ? {} : { failedCount: { increment: 1 } }),
      },
    });
  }

  return {
    eventId: event.id,
    subscriptionId: matchedSubId,
    signatureOk,
    topic,
    companyId,
    platform,
    payloadJson,
  };
}

// ──────────────────────────────────────────────────────────────────────
// HANDLER DISPATCH
// ──────────────────────────────────────────────────────────────────────

export async function processEvent(eventId: string): Promise<void> {
  const ev = await prisma.webhookEvent.findUnique({
    where: { id: eventId },
  });
  if (!ev) return;
  if (ev.status !== "pending") return;

  await prisma.webhookEvent.update({
    where: { id: ev.id },
    data: { status: "processing", attempts: { increment: 1 } },
  });

  try {
    await dispatch(
      ev.platform,
      ev.topic,
      ev.companyId,
      ev.payloadJson as any
    );
    await prisma.webhookEvent.update({
      where: { id: ev.id },
      data: { status: "done", processedAt: new Date(), lastError: null },
    });
  } catch (err: any) {
    await prisma.webhookEvent.update({
      where: { id: ev.id },
      data: {
        status: "failed",
        processedAt: new Date(),
        lastError: err?.message?.slice(0, 500) || "unknown error",
      },
    });
    if (ev.subscriptionId) {
      await prisma.webhookSubscription.update({
        where: { id: ev.subscriptionId },
        data: { failedCount: { increment: 1 } },
      });
    }
  }
}

async function dispatch(
  platform: string,
  topic: string,
  companyId: string,
  body: any
): Promise<void> {
  // Normalize topic — Shopify "customers/create", Salla "customer.created", etc.
  const norm = topic.toLowerCase().replace(/\./g, "/");

  // Customer created/updated — upsert into our CRM
  if (
    norm === "customers/create" ||
    norm === "customers/update" ||
    norm === "customer/created" ||
    norm === "customer/updated"
  ) {
    const c = extractCustomer(platform, body);
    if (c) {
      await upsertShopCustomer(companyId, platform, c.externalId, {
        fullName: c.fullName,
        email: c.email,
        phone: c.phone,
        country: c.country,
        city: c.city,
        lifetimeValue: c.lifetimeValue,
      });
    }
    return;
  }

  // Orders — upsert both the customer and a "won" deal tagged with the order
  if (
    norm === "orders/create" ||
    norm === "orders/paid" ||
    norm === "orders/updated" ||
    norm === "order/created" ||
    norm === "order/paid" ||
    norm === "order/updated"
  ) {
    const o = extractOrder(platform, body);
    if (o) {
      if (o.customer) {
        await upsertShopCustomer(companyId, platform, o.customer.externalId, {
          fullName: o.customer.fullName,
          email: o.customer.email,
          phone: o.customer.phone,
        });
      }
      // Find the customer we just upserted to link the deal
      const customer = o.customer
        ? await prisma.customer.findFirst({
            where: {
              companyId,
              externalId: `${platform}:${o.customer.externalId}`,
            },
            select: { id: true },
          })
        : null;

      if (customer) {
        // Idempotent-ish: dedup by title that embeds the order id
        const title = `${platform} order #${o.externalId}`;
        const existing = await prisma.deal.findFirst({
          where: { companyId, title },
          select: { id: true },
        });
        if (existing) {
          await prisma.deal.update({
            where: { id: existing.id },
            data: {
              value: o.total,
              currency: o.currency || "USD",
              stage: o.isPaid ? "won" : "proposal",
              probability: o.isPaid ? 100 : 50,
            },
          });
        } else {
          await prisma.deal.create({
            data: {
              companyId,
              customerId: customer.id,
              title,
              value: o.total,
              currency: o.currency || "USD",
              stage: o.isPaid ? "won" : "proposal",
              probability: o.isPaid ? 100 : 50,
            },
          });
        }
      }
    }
    return;
  }

  // Unhandled topic — not an error, just a no-op. The event row remains "done".
}

// ──────────────────────────────────────────────────────────────────────
// Platform-specific field extraction (thin, tolerant)
// ──────────────────────────────────────────────────────────────────────

interface ExtractedCustomer {
  externalId: string;
  fullName: string;
  email?: string | null;
  phone?: string | null;
  country?: string | null;
  city?: string | null;
  lifetimeValue?: number;
}

interface ExtractedOrder {
  externalId: string;
  total: number;
  currency: string | null;
  isPaid: boolean;
  customer: ExtractedCustomer | null;
}

function extractCustomer(platform: string, body: any): ExtractedCustomer | null {
  if (!body) return null;
  if (platform === "shopify") {
    const c = body.id ? body : body.customer;
    if (!c) return null;
    const first = (c.first_name || "").toString().trim();
    const last = (c.last_name || "").toString().trim();
    return {
      externalId: String(c.id),
      fullName: `${first} ${last}`.trim() || c.email || `Customer ${c.id}`,
      email: c.email || null,
      phone: c.phone || null,
      country: c.default_address?.country || null,
      city: c.default_address?.city || null,
      lifetimeValue: parseFloat(c.total_spent || "0") || 0,
    };
  }
  if (platform === "salla") {
    const c = body.data?.customer || body.customer || body.data || body;
    if (!c?.id) return null;
    const first = (c.first_name || "").toString().trim();
    const last = (c.last_name || "").toString().trim();
    return {
      externalId: String(c.id),
      fullName:
        `${first} ${last}`.trim() ||
        c.full_name ||
        c.email ||
        `Customer ${c.id}`,
      email: c.email || null,
      phone: c.mobile || c.phone || null,
      country: c.country || null,
      city: c.city || null,
    };
  }
  if (platform === "zid") {
    const c = body.customer || body.data || body;
    if (!c?.id) return null;
    return {
      externalId: String(c.id),
      fullName: c.name || c.email || `Customer ${c.id}`,
      email: c.email || null,
      phone: c.mobile || c.phone || null,
    };
  }
  if (platform === "woocommerce") {
    const c = body; // WC sends the resource at top level
    if (!c?.id) return null;
    const first = (c.first_name || c.billing?.first_name || "").toString().trim();
    const last = (c.last_name || c.billing?.last_name || "").toString().trim();
    return {
      externalId: String(c.id),
      fullName: `${first} ${last}`.trim() || c.email || `Customer ${c.id}`,
      email: c.email || c.billing?.email || null,
      phone: c.billing?.phone || null,
      country: c.billing?.country || null,
      city: c.billing?.city || null,
    };
  }
  if (platform === "youcan") {
    const c = body.customer || body.data || body;
    if (!c?.id) return null;
    return {
      externalId: String(c.id),
      fullName: c.full_name || c.name || c.email || `Customer ${c.id}`,
      email: c.email || null,
      phone: c.phone || null,
      country: c.country || null,
      city: c.city || null,
    };
  }
  return null;
}

function extractOrder(platform: string, body: any): ExtractedOrder | null {
  if (!body) return null;
  if (platform === "shopify") {
    const o = body.id ? body : body.order;
    if (!o) return null;
    const customer = o.customer
      ? extractCustomer("shopify", { customer: o.customer })
      : null;
    return {
      externalId: String(o.id),
      total: parseFloat(o.total_price || "0") || 0,
      currency: o.currency || null,
      isPaid: o.financial_status === "paid",
      customer,
    };
  }
  if (platform === "salla") {
    const o = body.data?.order || body.data || body.order || body;
    if (!o?.id) return null;
    const customer = o.customer
      ? extractCustomer("salla", { customer: o.customer })
      : null;
    const statusSlug = (o.status?.slug || o.status || "").toString().toLowerCase();
    return {
      externalId: String(o.id),
      total: parseFloat(o.amounts?.total?.amount || o.total?.amount || o.total || "0") || 0,
      currency: o.currency || o.amounts?.total?.currency || null,
      isPaid: ["paid", "completed", "delivered"].includes(statusSlug),
      customer,
    };
  }
  if (platform === "zid") {
    const o = body.order || body.data || body;
    if (!o?.id) return null;
    const customer = o.customer
      ? extractCustomer("zid", { customer: o.customer })
      : null;
    return {
      externalId: String(o.id),
      total: parseFloat(o.total || o.grand_total || "0") || 0,
      currency: o.currency || null,
      isPaid: (o.payment_status || "").toString().toLowerCase() === "paid",
      customer,
    };
  }
  if (platform === "woocommerce") {
    const o = body;
    if (!o?.id) return null;
    const customer = o.billing
      ? {
          externalId: String(o.customer_id || o.id),
          fullName: `${o.billing.first_name || ""} ${o.billing.last_name || ""}`.trim() ||
            o.billing.email ||
            `Customer ${o.customer_id || o.id}`,
          email: o.billing.email || null,
          phone: o.billing.phone || null,
          country: o.billing.country || null,
          city: o.billing.city || null,
        }
      : null;
    return {
      externalId: String(o.id),
      total: parseFloat(o.total || "0") || 0,
      currency: o.currency || null,
      isPaid: ["completed", "processing"].includes((o.status || "").toLowerCase()),
      customer,
    };
  }
  if (platform === "youcan") {
    const o = body.order || body.data || body;
    if (!o?.id) return null;
    const customer = o.customer
      ? extractCustomer("youcan", { customer: o.customer })
      : null;
    return {
      externalId: String(o.id),
      total: parseFloat(o.total || o.total_price || "0") || 0,
      currency: o.currency || null,
      isPaid: (o.status || "").toString().toLowerCase() === "paid",
      customer,
    };
  }
  return null;
}
