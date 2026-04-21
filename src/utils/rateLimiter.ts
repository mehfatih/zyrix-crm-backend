// ============================================================================
// RATE LIMITER — per-platform token-bucket for outbound e-commerce API calls
// ----------------------------------------------------------------------------
// Every request we make to Shopify / Salla / etc. admin APIs must respect the
// platform's published rate limits, or we'll get 429s and eventually have
// tokens revoked. This module provides a single rate-limited fetch wrapper
// that handles both per-platform limits AND per-shop limits (Shopify bills
// its bucket per-shop, not per-token).
//
// DESIGN
// ------
// Classic token bucket. Each bucket has:
//   • capacity — max tokens (allows short bursts)
//   • refillPerSec — sustained rate
// A request consumes one token. If no tokens available, it waits. Waiting is
// sleep + re-check, capped at maxWaitMs so a dead platform never hangs the
// whole sync.
//
// SCOPE
// -----
// In-process, single node. This is correct for Railway's single-instance
// backend. If we horizontally scale one day, we'd swap this for a Redis
// sliding-window, but the public interface (acquire/fetchWithLimit) stays
// identical. Callers don't need to know the backing store.
//
// 429 HANDLING
// ------------
// If the platform returns 429, fetchWithLimit honors Retry-After (seconds
// or HTTP date) and retries ONCE. Persistent 429s after that are surfaced
// to the caller so the sync's existing try/catch can record the error.
// ============================================================================

interface BucketConfig {
  capacity: number;
  refillPerSec: number;
}

// Tuned per platform's public docs (or conservative defaults where undocumented).
// Comments give the source so future ops can audit the numbers.
const PLATFORM_LIMITS: Record<string, BucketConfig> = {
  // Shopify REST Admin: 2 req/s standard stores, bucket depth 40.
  // https://shopify.dev/docs/api/usage/rate-limits#rest-admin-api-rate-limits
  shopify: { capacity: 40, refillPerSec: 2 },

  // Salla: 60 req/min documented — smooth to 1/sec with small burst.
  // https://docs.salla.dev/docs/api/rate-limits
  salla: { capacity: 10, refillPerSec: 1 },

  // Zid: 60 req/min documented in merchant developer portal.
  zid: { capacity: 10, refillPerSec: 1 },

  // WooCommerce: no hard platform limit but the host's PHP-FPM and DB
  // become the bottleneck. ~25 req/s is safe for shared hosts.
  woocommerce: { capacity: 25, refillPerSec: 25 },

  // YouCan: conservative default. Their docs don't publish a limit but
  // empirically ~30/min avoids throttling.
  youcan: { capacity: 6, refillPerSec: 0.5 },

  // EasyOrders: no public limit, conservative 30/min.
  easyorders: { capacity: 6, refillPerSec: 0.5 },

  // ExpandCart: REST API throttles around 20/min in practice.
  expandcart: { capacity: 4, refillPerSec: 0.33 },

  // Ticimax: SOAP endpoints, slow per-request — ~20/min is comfortable.
  ticimax: { capacity: 4, refillPerSec: 0.33 },

  // İdeasoft: ~30/min safe.
  ideasoft: { capacity: 6, refillPerSec: 0.5 },

  // T-Soft: ~30/min safe.
  tsoft: { capacity: 6, refillPerSec: 0.5 },

  // İkas GraphQL: generous, 20 req/s documented.
  ikas: { capacity: 20, refillPerSec: 20 },

  // Turhost: conservative 30/min.
  turhost: { capacity: 6, refillPerSec: 0.5 },
};

// Fallback for unknown platforms — safe and slow.
const DEFAULT_LIMIT: BucketConfig = { capacity: 3, refillPerSec: 0.25 };

class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  constructor(private readonly cfg: BucketConfig) {
    this.tokens = cfg.capacity;
    this.lastRefillMs = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefillMs) / 1000;
    if (elapsedSec <= 0) return;
    const refill = elapsedSec * this.cfg.refillPerSec;
    this.tokens = Math.min(this.cfg.capacity, this.tokens + refill);
    this.lastRefillMs = now;
  }

  /** Try to consume one token synchronously. Returns true if successful. */
  tryConsume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** How many ms until at least one token is available. */
  msUntilNextToken(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    const needed = 1 - this.tokens;
    return Math.ceil((needed / this.cfg.refillPerSec) * 1000);
  }
}

// One bucket per (platform, shopDomain) pair. Keying per-shop matters for
// Shopify (their limits are per-store, not per-app), and costs us basically
// nothing for platforms that limit per-token since we'd just be one entry
// per token anyway.
const buckets = new Map<string, TokenBucket>();

function bucketKey(platform: string, shopKey?: string): string {
  return shopKey ? `${platform}:${shopKey}` : platform;
}

function getBucket(platform: string, shopKey?: string): TokenBucket {
  const key = bucketKey(platform, shopKey);
  let b = buckets.get(key);
  if (!b) {
    const cfg = PLATFORM_LIMITS[platform.toLowerCase()] || DEFAULT_LIMIT;
    b = new TokenBucket(cfg);
    buckets.set(key, b);
  }
  return b;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Acquire one token for (platform, shop). Awaits if the bucket is empty.
 * Caps the wait at maxWaitMs so a misconfigured platform never hangs a sync
 * indefinitely — callers should treat a thrown RateLimitExceeded as a
 * non-fatal skip for that store's tick.
 */
export async function acquire(
  platform: string,
  shopKey?: string,
  maxWaitMs = 30_000
): Promise<void> {
  const bucket = getBucket(platform, shopKey);
  const started = Date.now();
  // Loop defensively — other concurrent acquirers may consume tokens
  // between our wait and our next check.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (bucket.tryConsume()) return;
    const waitMs = bucket.msUntilNextToken();
    if (Date.now() - started + waitMs > maxWaitMs) {
      throw new RateLimitExceededError(platform, shopKey);
    }
    await sleep(Math.min(waitMs, 1000)); // cap each sleep step at 1s for responsiveness
  }
}

export class RateLimitExceededError extends Error {
  constructor(platform: string, shopKey?: string) {
    super(
      `Rate limit wait exceeded maxWaitMs for ${platform}${
        shopKey ? `/${shopKey}` : ""
      }`
    );
    this.name = "RateLimitExceededError";
  }
}

/**
 * Parse a Retry-After header into milliseconds.
 * Handles both delta-seconds ('60') and HTTP-date formats.
 * Returns null if the header is absent or unparseable.
 */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  // Integer seconds
  const asInt = parseInt(trimmed, 10);
  if (!Number.isNaN(asInt) && asInt >= 0) {
    return asInt * 1000;
  }
  // HTTP-date
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    const diff = asDate - Date.now();
    return diff > 0 ? diff : 0;
  }
  return null;
}

/**
 * Rate-limited fetch wrapper. Respects our token bucket AND honors a 429
 * Retry-After response with exactly one retry. Use this in place of `fetch`
 * in ecommerce adapters.
 *
 * The `shopKey` should be the shopDomain (or some other per-shop identifier)
 * — Shopify and many others limit per-shop, not per-application-token, so
 * this is the correct bucketing dimension.
 */
export async function fetchWithLimit(
  platform: string,
  shopKey: string | undefined,
  input: string,
  init?: RequestInit
): Promise<Response> {
  await acquire(platform, shopKey);
  let resp = await fetch(input, init);
  if (resp.status === 429) {
    const retryAfterMs = parseRetryAfter(resp.headers.get("retry-after"));
    // Cap the 429-induced wait at 10 seconds — any longer and we let the
    // sync tick retry this store in the next cron pass.
    const waitMs = Math.min(retryAfterMs ?? 2000, 10_000);
    await sleep(waitMs);
    await acquire(platform, shopKey);
    resp = await fetch(input, init);
  }
  return resp;
}

/**
 * Diagnostic hook — returns a snapshot of current bucket state. Useful for
 * admin dashboards or the /api/admin/trigger-sync response.
 */
export function getBucketSnapshot(): Array<{
  key: string;
  platform: string;
  shopKey: string | null;
}> {
  return Array.from(buckets.keys()).map((key) => {
    const parts = key.split(":");
    return {
      key,
      platform: parts[0],
      shopKey: parts.length > 1 ? parts.slice(1).join(":") : null,
    };
  });
}
