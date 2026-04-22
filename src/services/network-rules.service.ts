// ============================================================================
// NETWORK RULES (P8)
// ----------------------------------------------------------------------------
// Platform-scope deny list + per-endpoint rate limits. Rules are cached in
// memory for 60s with bump-on-write. Matcher is used from
// middleware/networkRules.ts; v1 ships geo_block via CIDR deny list and
// rate_limit via sliding counter; ddos_heuristic is persisted but not yet
// applied (stub for follow-up).
// ============================================================================

import ipaddr from "ipaddr.js";
import { prisma } from "../config/database";
import { badRequest, notFound } from "../middleware/errorHandler";

export type NetworkRuleType = "geo_block" | "rate_limit" | "ddos_heuristic";

const VALID_TYPES: NetworkRuleType[] = [
  "geo_block",
  "rate_limit",
  "ddos_heuristic",
];

export interface NetworkRule {
  id: string;
  type: string;
  label: string;
  config: unknown;
  active: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// ──────────────────────────────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────────────────────────────

export interface UpsertRuleInput {
  type: NetworkRuleType;
  label: string;
  config: Record<string, unknown>;
  active?: boolean;
}

export async function listRules(): Promise<NetworkRule[]> {
  return prisma.networkRule.findMany({
    orderBy: [{ active: "desc" }, { type: "asc" }, { createdAt: "asc" }],
  });
}

export async function createRule(
  createdBy: string,
  input: UpsertRuleInput
): Promise<NetworkRule> {
  if (!(VALID_TYPES as string[]).includes(input.type)) {
    throw badRequest(`Invalid rule type: ${input.type}`);
  }
  if (!input.label?.trim()) throw badRequest("label is required");
  const row = await prisma.networkRule.create({
    data: {
      type: input.type,
      label: input.label.trim(),
      config: input.config as any,
      active: input.active !== false,
      createdBy,
    },
  });
  invalidateCache();
  return row;
}

export async function updateRule(
  id: string,
  patch: Partial<UpsertRuleInput>
): Promise<NetworkRule> {
  const existing = await prisma.networkRule.findUnique({ where: { id } });
  if (!existing) throw notFound("Network rule");
  const data: any = {};
  if (patch.label !== undefined) data.label = patch.label.trim();
  if (patch.config !== undefined) data.config = patch.config as any;
  if (patch.active !== undefined) data.active = patch.active;
  const row = await prisma.networkRule.update({ where: { id }, data });
  invalidateCache();
  return row;
}

export async function deleteRule(id: string): Promise<{ deleted: boolean }> {
  const existing = await prisma.networkRule.findUnique({ where: { id } });
  if (!existing) return { deleted: false };
  await prisma.networkRule.delete({ where: { id } });
  invalidateCache();
  return { deleted: true };
}

// ──────────────────────────────────────────────────────────────────────
// Compiled rule cache for middleware
// ──────────────────────────────────────────────────────────────────────

interface CompiledRules {
  fetchedAt: number;
  blockedRanges: Array<[ipaddr.IPv4 | ipaddr.IPv6, number]>;
  rateLimits: Array<{
    windowMs: number;
    max: number;
    pathPrefix?: string;
  }>;
}

const CACHE_TTL_MS = 60_000;
let cache: CompiledRules | null = null;

export function invalidateCache() {
  cache = null;
}

async function getCompiled(): Promise<CompiledRules> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache;

  const rules = await prisma.networkRule.findMany({
    where: { active: true },
  });

  const blockedRanges: Array<[ipaddr.IPv4 | ipaddr.IPv6, number]> = [];
  const rateLimits: CompiledRules["rateLimits"] = [];

  for (const r of rules) {
    try {
      const cfg = (r.config ?? {}) as Record<string, unknown>;
      if (r.type === "geo_block") {
        const list = Array.isArray(cfg.blockedCidrs) ? cfg.blockedCidrs : [];
        for (const entry of list) {
          if (typeof entry !== "string") continue;
          try {
            if (entry.includes("/")) {
              blockedRanges.push(
                ipaddr.parseCIDR(entry) as [ipaddr.IPv4 | ipaddr.IPv6, number]
              );
            } else {
              const addr = ipaddr.parse(entry);
              const mask = addr.kind() === "ipv6" ? 128 : 32;
              blockedRanges.push([addr as ipaddr.IPv4 | ipaddr.IPv6, mask]);
            }
          } catch {
            // ignore malformed CIDRs; they just won't match
          }
        }
      } else if (r.type === "rate_limit") {
        const windowMs =
          typeof cfg.windowMs === "number" ? cfg.windowMs : 60_000;
        const max = typeof cfg.max === "number" ? cfg.max : 600;
        const pathPrefix =
          typeof cfg.path === "string" ? cfg.path : undefined;
        rateLimits.push({ windowMs, max, pathPrefix });
      }
      // ddos_heuristic: stub for now.
    } catch {
      // swallow any per-rule config parse failures; the rest still work
    }
  }

  const compiled: CompiledRules = {
    fetchedAt: Date.now(),
    blockedRanges,
    rateLimits,
  };
  cache = compiled;
  return compiled;
}

// ──────────────────────────────────────────────────────────────────────
// Matchers used by middleware
// ──────────────────────────────────────────────────────────────────────

export async function isIpBlocked(ip: string | null | undefined) {
  if (!ip) return false;
  const c = await getCompiled();
  if (c.blockedRanges.length === 0) return false;
  try {
    const addr = ipaddr.parse(ip.trim());
    for (const [range, mask] of c.blockedRanges) {
      if (addr.kind() === range.kind()) {
        if (addr.match([range, mask] as any)) return true;
      }
    }
  } catch {
    // bad IP — leave to upstream
  }
  return false;
}

// Simple per-ip sliding-window counter shared across rules. Key is
// `${ip}|${pathPrefix||"*"}`. Purges lazily when an entry is read.
const counters = new Map<string, Array<number>>();

export async function checkRateLimit(
  ip: string | null | undefined,
  path: string
) {
  if (!ip) return { allowed: true };
  const c = await getCompiled();
  if (c.rateLimits.length === 0) return { allowed: true };

  const now = Date.now();
  for (const rule of c.rateLimits) {
    if (rule.pathPrefix && !path.startsWith(rule.pathPrefix)) continue;
    const key = `${ip}|${rule.pathPrefix || "*"}`;
    const windowStart = now - rule.windowMs;
    const arr = counters.get(key) ?? [];
    // drop expired
    while (arr.length > 0 && arr[0] < windowStart) arr.shift();
    arr.push(now);
    counters.set(key, arr);
    if (arr.length > rule.max) {
      return { allowed: false, windowMs: rule.windowMs, max: rule.max };
    }
  }
  return { allowed: true };
}
