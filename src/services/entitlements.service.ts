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

// ──────────────────────────────────────────────────────────────────────
// Platform-admin god-mode matrix (Sprint 16C)
// ──────────────────────────────────────────────────────────────────────

export type OverrideMode = "inherit" | "force_on" | "force_off";

export interface MatrixRow {
  key: string;
  category: string;
  type: "boolean" | "limit";
  label: { en: string; ar: string; tr: string };
  planDefault: { enabled: boolean; limit: number | null };
  override: { mode: OverrideMode; limitOverride: number | null };
  effective: { enabled: boolean; limit: number | null };
}

export interface AdminMatrix {
  plan: PlanSlug;
  rows: MatrixRow[];
}

/** Full per-tenant matrix for the admin Features tab. */
export async function getAdminMatrix(companyId: string): Promise<AdminMatrix> {
  const state = await loadCompanyState(companyId);
  const planRows = await loadPlanRows(state.plan);
  const rows: MatrixRow[] = FEATURE_CATALOG.map((def) => {
    const planRow = planRows.get(def.key);
    const planEnabled = planRow ? planRow.enabled : def.defaultByPlan[state.plan] === true;
    const planLimit = planRow
      ? planRow.limitValue
      : def.type === "limit" && def.limitByPlan
        ? def.limitByPlan[state.plan]
        : null;
    const ov = state.overrides.get(def.key);
    const mode = (ov?.mode as OverrideMode) ?? "inherit";
    return {
      key: def.key,
      category: def.category,
      type: def.type === "limit" ? "limit" : "boolean",
      label: def.label,
      planDefault: { enabled: planEnabled, limit: planLimit },
      override: { mode: ["inherit", "force_on", "force_off"].includes(mode) ? mode : "inherit", limitOverride: ov?.limitOverride ?? null },
      effective: resolveFromState(def.key, state, planRows),
    };
  });
  return { plan: state.plan, rows };
}

function isKnownKey(key: string): boolean {
  return FEATURE_CATALOG.some((f) => f.key === key);
}

async function writeAudit(
  companyId: string,
  actorId: string | undefined,
  action: string,
  featureKey: string | null,
  oldValue: unknown,
  newValue: unknown
) {
  await prisma.entitlementAudit.create({
    data: {
      companyId,
      actorId: actorId ?? null,
      action,
      featureKey,
      oldValue: (oldValue ?? null) as any,
      newValue: (newValue ?? null) as any,
    },
  });
}

/**
 * Set (or clear) a per-tenant override. mode 'inherit' with no limitOverride
 * deletes the row; otherwise upserts. Audited + cache-invalidated.
 */
export async function setOverride(
  companyId: string,
  key: string,
  mode: OverrideMode,
  limitOverride: number | null,
  actorId?: string
): Promise<MatrixRow> {
  if (!isKnownKey(key)) throw new Error(`Unknown feature: ${key}`);
  if (!["inherit", "force_on", "force_off"].includes(mode)) {
    throw new Error(`Invalid mode: ${mode}`);
  }
  const existing = await prisma.companyFeatureOverride.findUnique({
    where: { companyId_featureKey: { companyId, featureKey: key } },
  });
  const oldValue = existing
    ? { mode: existing.mode, limitOverride: existing.limitOverride }
    : { mode: "inherit", limitOverride: null };

  if (mode === "inherit" && (limitOverride === null || limitOverride === undefined)) {
    if (existing) {
      await prisma.companyFeatureOverride.delete({
        where: { companyId_featureKey: { companyId, featureKey: key } },
      });
    }
  } else {
    await prisma.companyFeatureOverride.upsert({
      where: { companyId_featureKey: { companyId, featureKey: key } },
      create: { companyId, featureKey: key, mode, limitOverride, updatedBy: actorId ?? null },
      update: { mode, limitOverride, updatedBy: actorId ?? null },
    });
  }
  await writeAudit(companyId, actorId, "set_override", key, oldValue, { mode, limitOverride });
  invalidateCompany(companyId);
  const matrix = await getAdminMatrix(companyId);
  return matrix.rows.find((r) => r.key === key)!;
}

/** Delete every override for the tenant (reset to plan). Audited + invalidated. */
export async function resetAllOverrides(companyId: string, actorId?: string): Promise<AdminMatrix> {
  const before = await prisma.companyFeatureOverride.findMany({ where: { companyId } });
  await prisma.companyFeatureOverride.deleteMany({ where: { companyId } });
  await writeAudit(companyId, actorId, "reset_all", null, { count: before.length }, { count: 0 });
  invalidateCompany(companyId);
  return getAdminMatrix(companyId);
}

/** Force ON every catalog feature for the tenant. Audited + invalidated. */
export async function forceOnAll(companyId: string, actorId?: string): Promise<AdminMatrix> {
  for (const def of FEATURE_CATALOG) {
    await prisma.companyFeatureOverride.upsert({
      where: { companyId_featureKey: { companyId, featureKey: def.key } },
      create: { companyId, featureKey: def.key, mode: "force_on", updatedBy: actorId ?? null },
      update: { mode: "force_on", updatedBy: actorId ?? null },
    });
  }
  await writeAudit(companyId, actorId, "force_on_all", null, null, { count: FEATURE_CATALOG.length });
  invalidateCompany(companyId);
  return getAdminMatrix(companyId);
}

export interface AuditEntry {
  id: string;
  actorId: string | null;
  action: string;
  featureKey: string | null;
  oldValue: unknown;
  newValue: unknown;
  createdAt: Date;
}

export async function listAudit(companyId: string, limit = 50): Promise<AuditEntry[]> {
  const rows = await prisma.entitlementAudit.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 200),
  });
  return rows as unknown as AuditEntry[];
}

/** Record a plan change in the entitlement audit + invalidate cache. Called by
 *  the admin updateCompany path when the plan field changes. */
export async function recordPlanChange(
  companyId: string,
  oldPlan: string,
  newPlan: string,
  actorId?: string
): Promise<void> {
  await writeAudit(companyId, actorId, "plan_change", null, { plan: oldPlan }, { plan: newPlan });
  invalidateCompany(companyId);
}
