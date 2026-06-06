// ============================================================================
// ENTITLEMENTS — single source of truth for plan→feature access (Sprint 16)
// ----------------------------------------------------------------------------
// resolve(companyId, featureKey) → { enabled, limit } with precedence:
//
//   1. company_feature_overrides   (force_on / force_off, + limitOverride)
//   2. legacy Company.enabledFeatures JSON  (honored as force_on/off during
//      the transition off the old per-company boolean map)
//   3. plan_features row for the company's plan (seeded from the catalog)
//   4. FEATURE_CATALOG default / limit  (canonical fallback)
//   5. unknown key → enabled:true, limit:null  (never block what we don't know)
//
// No other code computes entitlements. gateFeature() and the new
// requireFeature()/enforceLimit() (Phase B) all funnel through here, as does
// GET /api/entitlements/me. Resolution is cached per-company (short TTL) and
// per-plan, with explicit invalidation on any override or plan/plan_features
// change.
// ============================================================================

import { prisma } from "../config/database";
import {
  FEATURE_CATALOG,
  getCatalogDefault,
  getCatalogLimit,
  isLimitFeature,
  type PlanSlug,
} from "./feature-flags.service";

export interface Entitlement {
  enabled: boolean;
  limit: number | null; // null = unlimited / not a limit feature
  source: "override" | "legacy_json" | "plan" | "catalog" | "unknown";
}

export interface EntitlementsResult {
  plan: PlanSlug;
  features: Record<string, Entitlement>;
}

const PLAN_SLUGS: PlanSlug[] = ["free", "starter", "business", "enterprise"];
function asPlan(value: string | null | undefined): PlanSlug {
  return value && (PLAN_SLUGS as string[]).includes(value)
    ? (value as PlanSlug)
    : "free";
}

// ──────────────────────────────────────────────────────────────────────
// Caches
// ──────────────────────────────────────────────────────────────────────

interface CompanyEntitlementState {
  plan: PlanSlug;
  // featureKey → { mode, limitOverride }
  overrides: Map<string, { mode: string; limitOverride: number | null }>;
  // legacy JSON map (featureKey → boolean)
  legacy: Record<string, boolean>;
}

const COMPANY_TTL_MS = 30_000;
const PLAN_TTL_MS = 5 * 60_000;

const companyCache = new Map<
  string,
  { at: number; state: CompanyEntitlementState }
>();
// plan → (featureKey → { enabled, limitValue })
const planCache = new Map<
  string,
  { at: number; rows: Map<string, { enabled: boolean; limitValue: number | null }> }
>();

export function invalidateCompany(companyId: string): void {
  companyCache.delete(companyId);
}
export function invalidatePlan(plan?: string): void {
  if (plan) planCache.delete(plan);
  else planCache.clear();
}
export function invalidateAll(): void {
  companyCache.clear();
  planCache.clear();
}

// ──────────────────────────────────────────────────────────────────────
// Loaders
// ──────────────────────────────────────────────────────────────────────

async function loadCompanyState(
  companyId: string
): Promise<CompanyEntitlementState> {
  const hit = companyCache.get(companyId);
  if (hit && Date.now() - hit.at < COMPANY_TTL_MS) return hit.state;

  const companyRows = (await prisma.$queryRawUnsafe(
    `SELECT "plan", "enabledFeatures" FROM companies WHERE id = $1 LIMIT 1`,
    companyId
  )) as Array<{ plan: string | null; enabledFeatures: unknown }>;

  const plan = asPlan(companyRows[0]?.plan);
  const rawLegacy = companyRows[0]?.enabledFeatures;
  const legacy: Record<string, boolean> =
    rawLegacy && typeof rawLegacy === "object" && !Array.isArray(rawLegacy)
      ? (rawLegacy as Record<string, boolean>)
      : {};

  // The override table may not exist yet (pre-migration). Tolerate that so the
  // app keeps booting/serving on the legacy path until the migration is applied.
  let overrideRows: Array<{
    featureKey: string;
    mode: string;
    limitOverride: number | null;
  }> = [];
  try {
    overrideRows = (await prisma.$queryRawUnsafe(
      `SELECT "featureKey", "mode", "limitOverride"
         FROM company_feature_overrides WHERE "companyId" = $1`,
      companyId
    )) as typeof overrideRows;
  } catch {
    overrideRows = [];
  }

  const overrides = new Map<
    string,
    { mode: string; limitOverride: number | null }
  >();
  for (const r of overrideRows) {
    overrides.set(r.featureKey, {
      mode: r.mode,
      limitOverride:
        r.limitOverride === null || r.limitOverride === undefined
          ? null
          : Number(r.limitOverride),
    });
  }

  const state: CompanyEntitlementState = { plan, overrides, legacy };
  companyCache.set(companyId, { at: Date.now(), state });
  return state;
}

async function loadPlanRows(
  plan: PlanSlug
): Promise<Map<string, { enabled: boolean; limitValue: number | null }>> {
  const hit = planCache.get(plan);
  if (hit && Date.now() - hit.at < PLAN_TTL_MS) return hit.rows;

  let rows: Array<{
    featureKey: string;
    enabled: boolean;
    limitValue: number | null;
  }> = [];
  try {
    rows = (await prisma.$queryRawUnsafe(
      `SELECT "featureKey", "enabled", "limitValue"
         FROM plan_features WHERE "plan" = $1`,
      plan
    )) as typeof rows;
  } catch {
    rows = [];
  }

  const map = new Map<string, { enabled: boolean; limitValue: number | null }>();
  for (const r of rows) {
    map.set(r.featureKey, {
      enabled: r.enabled === true,
      limitValue:
        r.limitValue === null || r.limitValue === undefined
          ? null
          : Number(r.limitValue),
    });
  }
  planCache.set(plan, { at: Date.now(), rows: map });
  return map;
}

// ──────────────────────────────────────────────────────────────────────
// Core resolution
// ──────────────────────────────────────────────────────────────────────

function resolveFromState(
  key: string,
  state: CompanyEntitlementState,
  planRows: Map<string, { enabled: boolean; limitValue: number | null }>
): Entitlement {
  const plan = state.plan;

  // Plan-level default (plan_features table → catalog fallback).
  const planRow = planRows.get(key);
  const planEnabled = planRow ? planRow.enabled : getCatalogDefault(key, plan);
  const planLimit = planRow ? planRow.limitValue : getCatalogLimit(key, plan);

  const ov = state.overrides.get(key);
  const limitOverride = ov?.limitOverride ?? null;

  // ── Enabled ──
  let enabled: boolean;
  let source: Entitlement["source"];
  if (ov && ov.mode === "force_on") {
    enabled = true;
    source = "override";
  } else if (ov && ov.mode === "force_off") {
    enabled = false;
    source = "override";
  } else if (key in state.legacy) {
    enabled = state.legacy[key] === true;
    source = "legacy_json";
  } else if (planRow) {
    enabled = planEnabled;
    source = "plan";
  } else {
    // not in plan_features → catalog (or unknown)
    const known = FEATURE_CATALOG.some((f) => f.key === key);
    enabled = known ? planEnabled : true;
    source = known ? "catalog" : "unknown";
  }

  // ── Limit ── (only meaningful for limit-type features)
  let limit: number | null;
  if (!isLimitFeature(key)) {
    limit = null;
  } else if (limitOverride !== null) {
    limit = limitOverride;
  } else {
    limit = planLimit;
  }

  return { enabled, limit, source };
}

/**
 * Resolve a single feature for a company.
 */
export async function resolveFeature(
  companyId: string,
  key: string
): Promise<Entitlement> {
  const state = await loadCompanyState(companyId);
  const planRows = await loadPlanRows(state.plan);
  return resolveFromState(key, state, planRows);
}

/**
 * Resolve the whole catalog for a company (used by GET /api/entitlements/me
 * and the legacy getFullFeatureMap).
 */
export async function resolveAll(
  companyId: string
): Promise<EntitlementsResult> {
  const state = await loadCompanyState(companyId);
  const planRows = await loadPlanRows(state.plan);
  const features: Record<string, Entitlement> = {};
  for (const def of FEATURE_CATALOG) {
    features[def.key] = resolveFromState(def.key, state, planRows);
  }
  return { plan: state.plan, features };
}

/** Convenience boolean used by the legacy isFeatureEnabled wrapper. */
export async function isEnabled(
  companyId: string,
  key: string
): Promise<boolean> {
  return (await resolveFeature(companyId, key)).enabled;
}

/** Boolean-only map for the legacy getFullFeatureMap shape. */
export async function booleanMap(
  companyId: string
): Promise<Record<string, boolean>> {
  const { features } = await resolveAll(companyId);
  const out: Record<string, boolean> = {};
  for (const k of Object.keys(features)) out[k] = features[k].enabled;
  return out;
}
