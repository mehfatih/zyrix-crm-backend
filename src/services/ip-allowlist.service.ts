// ============================================================================
// IP ALLOWLIST (P4)
// ----------------------------------------------------------------------------
// CRUD + an efficient per-company matcher. Matcher results are cached
// in-memory for 60s to avoid hammering the DB on every authenticated
// request; the cache is bumped on any write so new rules take effect
// immediately.
// ============================================================================

import ipaddr from "ipaddr.js";
import { prisma } from "../config/database";
import { badRequest } from "../middleware/errorHandler";

export interface IpAllowlistEntry {
  id: string;
  companyId: string;
  cidr: string;
  label: string;
  createdBy: string;
  createdAt: Date;
}

// ──────────────────────────────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────────────────────────────

export interface CidrParsed {
  ok: boolean;
  parsed?: [ipaddr.IPv4 | ipaddr.IPv6, number];
  reason?: string;
}

export function parseCidr(cidr: string): CidrParsed {
  const input = cidr.trim();
  try {
    if (input.includes("/")) {
      const range = ipaddr.parseCIDR(input) as [
        ipaddr.IPv4 | ipaddr.IPv6,
        number
      ];
      return { ok: true, parsed: range };
    }
    // Plain IP → treat as /32 (v4) or /128 (v6)
    const addr = ipaddr.parse(input);
    const mask = addr.kind() === "ipv6" ? 128 : 32;
    return { ok: true, parsed: [addr as ipaddr.IPv4 | ipaddr.IPv6, mask] };
  } catch {
    return { ok: false, reason: `Invalid CIDR: ${cidr}` };
  }
}

// ──────────────────────────────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────────────────────────────

export async function listAllowlist(
  companyId: string
): Promise<IpAllowlistEntry[]> {
  return prisma.ipAllowlist.findMany({
    where: { companyId },
    orderBy: { createdAt: "asc" },
  });
}

export async function addAllowlistEntry(
  companyId: string,
  createdBy: string,
  input: { cidr: string; label: string }
): Promise<IpAllowlistEntry> {
  const cidr = input.cidr.trim();
  const label = input.label.trim();
  if (!cidr) throw badRequest("cidr is required");
  if (!label) throw badRequest("label is required");
  if (label.length > 120) throw badRequest("label must be 120 chars or less");
  const check = parseCidr(cidr);
  if (!check.ok) throw badRequest(check.reason ?? "Invalid CIDR");
  const row = await prisma.ipAllowlist.create({
    data: { companyId, cidr, label, createdBy },
  });
  invalidateCache(companyId);
  return row;
}

export async function deleteAllowlistEntry(
  companyId: string,
  id: string
): Promise<{ deleted: boolean }> {
  const row = await prisma.ipAllowlist.findFirst({
    where: { id, companyId },
    select: { id: true },
  });
  if (!row) return { deleted: false };
  await prisma.ipAllowlist.delete({ where: { id } });
  invalidateCache(companyId);
  return { deleted: true };
}

// ──────────────────────────────────────────────────────────────────────
// Matcher — called from the middleware on every authenticated request.
// ──────────────────────────────────────────────────────────────────────

interface CachedRules {
  fetchedAt: number;
  ranges: Array<[ipaddr.IPv4 | ipaddr.IPv6, number]>;
  isEmpty: boolean;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CachedRules>();

function invalidateCache(companyId: string) {
  cache.delete(companyId);
}

async function loadRules(companyId: string): Promise<CachedRules> {
  const cached = cache.get(companyId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }
  const rows = await prisma.ipAllowlist.findMany({
    where: { companyId },
    select: { cidr: true },
  });
  const ranges: Array<[ipaddr.IPv4 | ipaddr.IPv6, number]> = [];
  for (const r of rows) {
    const parsed = parseCidr(r.cidr);
    if (parsed.ok && parsed.parsed) ranges.push(parsed.parsed);
  }
  const fresh: CachedRules = {
    fetchedAt: Date.now(),
    ranges,
    isEmpty: ranges.length === 0,
  };
  cache.set(companyId, fresh);
  return fresh;
}

/**
 * Decides if `ip` is permitted for `companyId`.
 * - companies with zero allowlist rules: always allowed (opt-in feature)
 * - companies with ≥1 rule: IP must match at least one range
 * - malformed incoming IP: denied
 */
export async function isIpAllowed(
  companyId: string,
  ip: string | null | undefined
): Promise<{ allowed: boolean; reason?: string }> {
  const rules = await loadRules(companyId);
  if (rules.isEmpty) return { allowed: true };
  if (!ip) return { allowed: false, reason: "No client IP" };
  try {
    const addr = ipaddr.parse(ip.trim());
    for (const [range, mask] of rules.ranges) {
      // ipaddr.match requires the address kinds to agree
      if (addr.kind() === range.kind()) {
        if (addr.match([range, mask] as any)) return { allowed: true };
      } else if (
        addr.kind() === "ipv6" &&
        (addr as ipaddr.IPv6).isIPv4MappedAddress()
      ) {
        // IPv4-mapped IPv6 (e.g. ::ffff:203.0.113.5) vs an IPv4 rule
        const v4 = (addr as ipaddr.IPv6).toIPv4Address();
        if (range.kind() === "ipv4" && v4.match([range as ipaddr.IPv4, mask])) {
          return { allowed: true };
        }
      }
    }
    return { allowed: false, reason: "IP not in allowlist" };
  } catch {
    return { allowed: false, reason: "Could not parse client IP" };
  }
}
