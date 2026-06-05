// ============================================================================
// SSRF GUARD (Sprint 13)
// ----------------------------------------------------------------------------
// Validates an outbound webhook URL before we fetch it, so a tenant can't point
// a recipe at internal infrastructure (cloud metadata endpoints, the DB host,
// localhost, RFC-1918 ranges, link-local, etc.). Resolves the hostname and
// checks EVERY resolved address — a public-looking domain that resolves to a
// private IP is still blocked.
// ============================================================================

import { promises as dns } from "dns";
import ipaddr from "ipaddr.js";

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

// ipaddr.js range names that are NOT safe to reach from the server.
const BLOCKED_RANGES = new Set([
  "unspecified", // 0.0.0.0 / ::
  "broadcast",
  "multicast",
  "linkLocal", // 169.254.0.0/16, fe80::/10 (includes cloud metadata 169.254.169.254)
  "loopback", // 127.0.0.0/8, ::1
  "private", // 10/8, 172.16/12, 192.168/16
  "uniqueLocal", // fc00::/7
  "carrierGradeNat", // 100.64.0.0/10
  "reserved",
]);

function ipIsBlocked(addr: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(addr);
  } catch {
    return true; // unparseable → block defensively
  }
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) → evaluate the embedded v4.
  if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  return BLOCKED_RANGES.has(parsed.range());
}

export interface SsrfCheckOptions {
  requireHttps?: boolean; // recipes require https; default true
}

/**
 * Throws SsrfError if the URL is unsafe to call. On success returns the parsed
 * URL. Resolves DNS and rejects if ANY resolved address is in a blocked range.
 */
export async function assertSafeWebhookUrl(
  rawUrl: string,
  opts: SsrfCheckOptions = {}
): Promise<URL> {
  const requireHttps = opts.requireHttps !== false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError("Invalid URL");
  }

  if (requireHttps) {
    if (url.protocol !== "https:") {
      throw new SsrfError("URL must use https");
    }
  } else if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError("URL must use http(s)");
  }

  // Block obvious internal hostnames outright (belt-and-braces with DNS).
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new SsrfError("Host is not allowed");
  }

  // If the host is a literal IP, check it directly. Otherwise resolve it.
  if (ipaddr.isValid(host)) {
    if (ipIsBlocked(host)) throw new SsrfError("URL resolves to a private/reserved address");
    return url;
  }

  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new SsrfError("Could not resolve host");
  }
  if (addrs.length === 0) throw new SsrfError("Host did not resolve");
  for (const a of addrs) {
    if (ipIsBlocked(a.address)) {
      throw new SsrfError("URL resolves to a private/reserved address");
    }
  }
  return url;
}
