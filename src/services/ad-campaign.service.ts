// ============================================================================
// CAMPAIGN ECONOMICS (Sprint 24) — unified ad campaigns + spend ledger (raw SQL).
// ----------------------------------------------------------------------------
// Tenant-scoped (companyId). Raw-SQL tables (ad_campaigns, ad_spend_entries),
// relation-free — accessed via $queryRawUnsafe, mirroring the Sprint 18/19/20
// tickets/KB/landing-pages convention. Gated by the `campaign_economics`
// entitlement (BUSINESS_UP).
//
// GOAL: per-campaign real net profit/loss in the company base currency (TRY):
//   net = revenue (from that campaign's deals) − ad spend − COGS.
//
// Phase A (this file): the UNIFIED campaign model across all 6 platforms + the
// spend ledger with TWO entry modes — (1) TRY directly (no conversion) or (2) a
// native ad-account currency converted to base via the Sprint-23 FX engine,
// frozen at spendDate. amountBase is NULL (never a guess) when no rate exists,
// surfacing a "set an exchange rate" badge — identical to deal economics.
// Direct platform-API pulls fill these SAME rows later (entryMode='api').
//
// Revenue rollup / ROAS / CPA (Phase B) and alerts (Phase D) build on top.
// ============================================================================

import { randomUUID } from "crypto";
import { prisma } from "../config/database";
import { getBaseCurrency, resolveRateToBase, type FxSource } from "./deal-economics.service";
import { isEnabled } from "./entitlements.service";
import { createBulkNotifications } from "./notifications.service";

// Unified set of supported ad platforms. Free-text in the DB (like Campaign.channel);
// validated here + in the zod layer. All 6 get manual entry now; direct-API pulls
// are deferred per-platform sprints.
export const AD_PLATFORMS = [
  "meta",
  "google",
  "tiktok",
  "snapchat",
  "twitter",
  "linkedin",
  "other",
] as const;
export type AdPlatform = (typeof AD_PLATFORMS)[number];

export const CAMPAIGN_STATUSES = ["active", "paused", "archived"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const ENTRY_MODES = ["manual", "api"] as const;
export type EntryMode = (typeof ENTRY_MODES)[number];

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function toNum(v: unknown): number {
  return v == null ? 0 : Number(v);
}
function toNumOrNull(v: unknown): number | null {
  return v == null ? null : Number(v);
}

/** Parse a YYYY-MM-DD (or ISO) string to a UTC-midnight Date; null on garbage. */
function parseDateOnly(v: unknown): Date | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

function dateOnlyStr(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : null;
}

function coercePlatform(v: unknown): AdPlatform {
  return (AD_PLATFORMS as readonly string[]).includes(String(v)) ? (v as AdPlatform) : "other";
}
function coerceStatus(v: unknown): CampaignStatus {
  return (CAMPAIGN_STATUSES as readonly string[]).includes(String(v)) ? (v as CampaignStatus) : "active";
}
function normCurrency(v: unknown, fallback: string): string {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return /^[A-Z]{3}$/.test(s) ? s : fallback;
}

// ──────────────────────────────────────────────────────────────────────
// Campaigns
// ──────────────────────────────────────────────────────────────────────

export interface AdCampaign {
  id: string;
  companyId: string;
  name: string;
  platform: string;
  externalId: string | null;
  accountCurrency: string | null;
  status: string;
  objective: string | null;
  targetRoas: number | null;
  targetCpa: number | null;
  alertsEnabled: boolean;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Campaign + full economics roll-up (spend + attributed revenue + ROAS/CPA). */
export interface AdCampaignWithEconomics extends AdCampaign {
  economics: CampaignEconomics;
}

const CAMPAIGN_COLS = `
  "id","companyId","name","platform","externalId","accountCurrency","status",
  "objective","targetRoas"::text AS "targetRoas","targetCpa"::text AS "targetCpa",
  "alertsEnabled","createdById","createdAt","updatedAt"
`;

function mapCampaign(r: Record<string, unknown>): AdCampaign {
  return {
    id: String(r.id),
    companyId: String(r.companyId),
    name: String(r.name),
    platform: String(r.platform),
    externalId: (r.externalId as string | null) ?? null,
    accountCurrency: (r.accountCurrency as string | null) ?? null,
    status: String(r.status),
    objective: (r.objective as string | null) ?? null,
    targetRoas: toNumOrNull(r.targetRoas),
    targetCpa: toNumOrNull(r.targetCpa),
    alertsEnabled: r.alertsEnabled === true,
    createdById: (r.createdById as string | null) ?? null,
    createdAt: r.createdAt as Date,
    updatedAt: r.updatedAt as Date,
  };
}

export async function listCampaigns(companyId: string): Promise<AdCampaignWithEconomics[]> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT ${CAMPAIGN_COLS} FROM ad_campaigns WHERE "companyId" = $1 ORDER BY "updatedAt" DESC`,
    companyId
  )) as Array<Record<string, unknown>>;
  const campaigns = rows.map(mapCampaign);
  // Campaign cardinality per tenant is low (tens), so a per-campaign roll-up loop
  // is fine; base currency is resolved once and threaded in.
  const base = await getBaseCurrency(companyId);
  const out: AdCampaignWithEconomics[] = [];
  for (const c of campaigns) {
    out.push({ ...c, economics: await computeCampaignEconomics(companyId, c, base) });
  }
  return out;
}

export async function getCampaign(companyId: string, id: string): Promise<AdCampaign | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT ${CAMPAIGN_COLS} FROM ad_campaigns WHERE "companyId" = $1 AND "id" = $2 LIMIT 1`,
    companyId,
    id
  )) as Array<Record<string, unknown>>;
  return rows[0] ? mapCampaign(rows[0]) : null;
}

export interface CampaignInput {
  name?: string;
  platform?: string;
  externalId?: string | null;
  accountCurrency?: string | null;
  status?: string;
  objective?: string | null;
  targetRoas?: number | null;
  targetCpa?: number | null;
  alertsEnabled?: boolean;
}

export async function createCampaign(
  companyId: string,
  createdById: string | null,
  input: CampaignInput
): Promise<AdCampaign> {
  const id = randomUUID();
  const name = (input.name ?? "").trim() || "Untitled campaign";
  const platform = coercePlatform(input.platform);
  const status = coerceStatus(input.status);
  const accountCurrency = input.accountCurrency
    ? normCurrency(input.accountCurrency, "")
    : null;
  await prisma.$executeRawUnsafe(
    `INSERT INTO ad_campaigns
       ("id","companyId","name","platform","externalId","accountCurrency","status",
        "objective","targetRoas","targetCpa","alertsEnabled","createdById","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW())`,
    id,
    companyId,
    name,
    platform,
    input.externalId ?? null,
    accountCurrency || null,
    status,
    input.objective ?? null,
    input.targetRoas ?? null,
    input.targetCpa ?? null,
    input.alertsEnabled === true,
    createdById
  );
  return (await getCampaign(companyId, id))!;
}

export async function updateCampaign(
  companyId: string,
  id: string,
  patch: CampaignInput
): Promise<AdCampaign | null> {
  const current = await getCampaign(companyId, id);
  if (!current) return null;

  const name = patch.name !== undefined ? (patch.name.trim() || current.name) : current.name;
  const platform = patch.platform !== undefined ? coercePlatform(patch.platform) : current.platform;
  const status = patch.status !== undefined ? coerceStatus(patch.status) : current.status;
  const externalId = patch.externalId !== undefined ? patch.externalId : current.externalId;
  const accountCurrency =
    patch.accountCurrency !== undefined
      ? (patch.accountCurrency ? normCurrency(patch.accountCurrency, "") || null : null)
      : current.accountCurrency;
  const objective = patch.objective !== undefined ? patch.objective : current.objective;
  const targetRoas = patch.targetRoas !== undefined ? patch.targetRoas : current.targetRoas;
  const targetCpa = patch.targetCpa !== undefined ? patch.targetCpa : current.targetCpa;
  const alertsEnabled =
    patch.alertsEnabled !== undefined ? patch.alertsEnabled : current.alertsEnabled;

  await prisma.$executeRawUnsafe(
    `UPDATE ad_campaigns
       SET "name" = $3, "platform" = $4, "externalId" = $5, "accountCurrency" = $6,
           "status" = $7, "objective" = $8, "targetRoas" = $9, "targetCpa" = $10,
           "alertsEnabled" = $11, "updatedAt" = NOW()
     WHERE "companyId" = $1 AND "id" = $2`,
    companyId,
    id,
    name,
    platform,
    externalId ?? null,
    accountCurrency ?? null,
    status,
    objective ?? null,
    targetRoas ?? null,
    targetCpa ?? null,
    alertsEnabled
  );
  return getCampaign(companyId, id);
}

/** Delete a campaign + its spend ledger (relation-free, so cascade by hand). */
export async function deleteCampaign(companyId: string, id: string): Promise<boolean> {
  const current = await getCampaign(companyId, id);
  if (!current) return false;
  await prisma.$executeRawUnsafe(
    `DELETE FROM ad_spend_entries WHERE "companyId" = $1 AND "adCampaignId" = $2`,
    companyId,
    id
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM ad_campaigns WHERE "companyId" = $1 AND "id" = $2`,
    companyId,
    id
  );
  return true;
}

// ──────────────────────────────────────────────────────────────────────
// Spend entries
// ──────────────────────────────────────────────────────────────────────

export interface AdSpendEntry {
  id: string;
  companyId: string;
  adCampaignId: string;
  platform: string;
  spendDate: string; // YYYY-MM-DD
  amount: number;
  currency: string;
  amountBase: number | null;
  fxRateToBase: number | null;
  fxRateSource: string | null;
  fxRateDate: string | null;
  entryMode: string;
  externalId: string | null;
  note: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const SPEND_COLS = `
  "id","companyId","adCampaignId","platform","spendDate"::text AS "spendDate",
  "amount"::text AS "amount","currency","amountBase"::text AS "amountBase",
  "fxRateToBase"::text AS "fxRateToBase","fxRateSource","fxRateDate"::text AS "fxRateDate",
  "entryMode","externalId","note","createdById","createdAt","updatedAt"
`;

function mapSpend(r: Record<string, unknown>): AdSpendEntry {
  return {
    id: String(r.id),
    companyId: String(r.companyId),
    adCampaignId: String(r.adCampaignId),
    platform: String(r.platform),
    spendDate: dateOnlyStr(r.spendDate) ?? "",
    amount: toNum(r.amount),
    currency: String(r.currency),
    amountBase: toNumOrNull(r.amountBase),
    fxRateToBase: toNumOrNull(r.fxRateToBase),
    fxRateSource: (r.fxRateSource as string | null) ?? null,
    fxRateDate: dateOnlyStr(r.fxRateDate),
    entryMode: String(r.entryMode),
    externalId: (r.externalId as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    createdById: (r.createdById as string | null) ?? null,
    createdAt: r.createdAt as Date,
    updatedAt: r.updatedAt as Date,
  };
}

interface Conversion {
  amountBase: number | null;
  fxRateToBase: number | null;
  fxRateSource: FxSource;
}

// Convert a native spend amount to base currency, frozen at spendDate. TRY-direct
// (currency === base) returns source 'same'/rate 1; otherwise the Sprint-23 FX
// engine resolves (manual override → live at-date). No rate → amountBase null +
// source 'unavailable' (honest "set a rate", never a guess).
async function convertSpend(
  companyId: string,
  amount: number,
  currency: string,
  base: string,
  spendDate: Date
): Promise<Conversion> {
  const { rate, source } = await resolveRateToBase(companyId, currency, base, spendDate);
  return {
    amountBase: rate != null ? round2(amount * rate) : null,
    fxRateToBase: rate,
    fxRateSource: source,
  };
}

export async function listSpend(companyId: string, campaignId: string): Promise<AdSpendEntry[]> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT ${SPEND_COLS} FROM ad_spend_entries
      WHERE "companyId" = $1 AND "adCampaignId" = $2
      ORDER BY "spendDate" DESC, "createdAt" DESC`,
    companyId,
    campaignId
  )) as Array<Record<string, unknown>>;
  return rows.map(mapSpend);
}

export async function getSpend(
  companyId: string,
  campaignId: string,
  spendId: string
): Promise<AdSpendEntry | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT ${SPEND_COLS} FROM ad_spend_entries
      WHERE "companyId" = $1 AND "adCampaignId" = $2 AND "id" = $3 LIMIT 1`,
    companyId,
    campaignId,
    spendId
  )) as Array<Record<string, unknown>>;
  return rows[0] ? mapSpend(rows[0]) : null;
}

export interface SpendInput {
  spendDate?: string;
  amount?: number;
  currency?: string;
  note?: string | null;
}

export class SpendValidationError extends Error {}

/**
 * Add a manual spend entry to a campaign. The currency may be base (TRY) directly
 * or the ad account's native currency — converted + frozen at spendDate either way.
 * Returns null when the campaign doesn't exist for this company; throws
 * SpendValidationError on a bad amount/date.
 */
export async function addSpend(
  companyId: string,
  campaignId: string,
  createdById: string | null,
  input: SpendInput
): Promise<AdSpendEntry | null> {
  const campaign = await getCampaign(companyId, campaignId);
  if (!campaign) return null;

  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new SpendValidationError("amount must be a non-negative number");
  }
  const spendDate = parseDateOnly(input.spendDate);
  if (!spendDate) throw new SpendValidationError("spendDate must be YYYY-MM-DD");

  const base = await getBaseCurrency(companyId);
  // Default the entry currency to the account currency, else base.
  const currency = normCurrency(input.currency, campaign.accountCurrency || base);
  const conv = await convertSpend(companyId, round2(amount), currency, base, spendDate);

  const id = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO ad_spend_entries
       ("id","companyId","adCampaignId","platform","spendDate","amount","currency",
        "amountBase","fxRateToBase","fxRateSource","fxRateDate","entryMode",
        "externalId","note","createdById","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8,$9,$10,$11::date,'manual',NULL,$12,$13,NOW(),NOW())`,
    id,
    companyId,
    campaignId,
    campaign.platform,
    spendDate.toISOString().slice(0, 10),
    round2(amount),
    currency,
    conv.amountBase,
    conv.fxRateToBase,
    conv.fxRateSource,
    spendDate.toISOString().slice(0, 10),
    input.note ?? null,
    createdById
  );
  return getSpend(companyId, campaignId, id);
}

/**
 * Edit a spend entry. If amount / currency / spendDate change, the base-currency
 * conversion is re-frozen at the (new) spendDate. Manual entries only — leaves the
 * entryMode untouched. Returns null when the entry doesn't exist for this company.
 */
export async function updateSpend(
  companyId: string,
  campaignId: string,
  spendId: string,
  patch: SpendInput
): Promise<AdSpendEntry | null> {
  const current = await getSpend(companyId, campaignId, spendId);
  if (!current) return null;

  const amount =
    patch.amount !== undefined ? Number(patch.amount) : current.amount;
  if (!Number.isFinite(amount) || amount < 0) {
    throw new SpendValidationError("amount must be a non-negative number");
  }
  let spendDate: Date;
  if (patch.spendDate !== undefined) {
    const d = parseDateOnly(patch.spendDate);
    if (!d) throw new SpendValidationError("spendDate must be YYYY-MM-DD");
    spendDate = d;
  } else {
    spendDate = parseDateOnly(current.spendDate) ?? new Date();
  }
  const currency =
    patch.currency !== undefined ? normCurrency(patch.currency, current.currency) : current.currency;

  const base = await getBaseCurrency(companyId);
  const conv = await convertSpend(companyId, round2(amount), currency, base, spendDate);
  const note = patch.note !== undefined ? patch.note : current.note;

  await prisma.$executeRawUnsafe(
    `UPDATE ad_spend_entries
       SET "spendDate" = $4::date, "amount" = $5, "currency" = $6, "amountBase" = $7,
           "fxRateToBase" = $8, "fxRateSource" = $9, "fxRateDate" = $4::date,
           "note" = $10, "updatedAt" = NOW()
     WHERE "companyId" = $1 AND "adCampaignId" = $2 AND "id" = $3`,
    companyId,
    campaignId,
    spendId,
    spendDate.toISOString().slice(0, 10),
    round2(amount),
    currency,
    conv.amountBase,
    conv.fxRateToBase,
    conv.fxRateSource,
    note ?? null
  );
  return getSpend(companyId, campaignId, spendId);
}

export async function deleteSpend(
  companyId: string,
  campaignId: string,
  spendId: string
): Promise<boolean> {
  const n = await prisma.$executeRawUnsafe(
    `DELETE FROM ad_spend_entries WHERE "companyId" = $1 AND "adCampaignId" = $2 AND "id" = $3`,
    companyId,
    campaignId,
    spendId
  );
  return Number(n) > 0;
}

// ──────────────────────────────────────────────────────────────────────
// Economics roll-up (Phase B) — revenue attribution + ROAS / CPA / net profit
// ──────────────────────────────────────────────────────────────────────

// Map a unified ad platform to the lead_sources.source values that attribute to
// it. Only Meta + Google have lead-capture plumbing today; the other four
// platforms attribute revenue solely through the explicit deals.adCampaignId tag.
function sourcesForPlatform(platform: string): string[] {
  switch (platform) {
    case "meta":
      return ["meta_lead_ad"];
    case "google":
      return ["google_ads_lead"];
    default:
      return [];
  }
}

export interface CampaignEconomics {
  baseCurrency: string;
  // Spend (from the ledger).
  spendBase: number;
  spendEntryCount: number;
  spendUnconverted: number; // spend rows with no resolvable rate (amountBase NULL)
  spendComplete: boolean;
  // Revenue (won deals attributed to this campaign, Sprint-23 base value).
  revenueBase: number;
  dealsWon: number;
  revenueUnstamped: number; // attributed won deals with NULL baseValue (no FX at close)
  revenueComplete: boolean;
  leadsCount: number; // lead_sources matched (informational; 0 for non-lead platforms)
  // COGS (Sprint-23 rolled-up cost of the attributed won deals).
  cogsBase: number;
  cogsMissing: number; // attributed won deals with NULL cogsBase
  cogsComplete: boolean;
  // Derived.
  netProfit: number; // revenueBase − spendBase − cogsBase (base currency)
  roas: number | null; // revenueBase / spendBase (null when no spend)
  cpa: number | null; // spendBase / dealsWon (cost per acquisition; null when no wins)
  marginPct: number | null; // netProfit / revenueBase × 100
}

/**
 * Full per-campaign economics in the company base currency (TRY default).
 *
 * Revenue attribution (rolls up Sprint-23 deal economics):
 *   - EXPLICIT: deals.adCampaignId = this campaign (always attributes; wins over
 *     any lead_sources link — so a tagged deal counts once, here).
 *   - AUTO-MATCH: untagged won deals whose lead_sources row carries this
 *     campaign's externalId AND a source mapping to its platform (Meta/Google).
 * Only won deals contribute revenue/COGS. baseValue/cogsBase are the frozen
 * Sprint-23 stamps; NULLs are summed as 0 but counted so the surface can warn.
 */
export async function computeCampaignEconomics(
  companyId: string,
  campaign: AdCampaign,
  base?: string
): Promise<CampaignEconomics> {
  const baseCurrency = base ?? (await getBaseCurrency(companyId));

  // ── Spend roll-up ──
  const spendRows = (await prisma.$queryRawUnsafe(
    `SELECT COALESCE(SUM("amountBase"),0)::text AS "spendBase",
            COUNT(*)::int AS "spendEntryCount",
            COUNT(*) FILTER (WHERE "amountBase" IS NULL)::int AS "spendUnconverted"
       FROM ad_spend_entries WHERE "companyId" = $1 AND "adCampaignId" = $2`,
    companyId,
    campaign.id
  )) as Array<Record<string, unknown>>;
  const spendBase = round2(toNum(spendRows[0]?.spendBase));
  const spendEntryCount = Number(spendRows[0]?.spendEntryCount ?? 0);
  const spendUnconverted = Number(spendRows[0]?.spendUnconverted ?? 0);

  const sources = sourcesForPlatform(campaign.platform);
  const canAutoMatch = campaign.externalId != null && sources.length > 0;

  // ── Attributed won-deal revenue + COGS ──
  // Explicit tag always attributes; the lead_sources branch applies only to
  // untagged deals (so explicit tagging takes priority and never double-counts).
  let attrSql =
    `SELECT COUNT(*)::int AS "dealsWon",
            COALESCE(SUM(d."baseValue"),0)::text AS "revenueBase",
            COUNT(*) FILTER (WHERE d."baseValue" IS NULL)::int AS "revenueUnstamped",
            COALESCE(SUM(d."cogsBase"),0)::text AS "cogsBase",
            COUNT(*) FILTER (WHERE d."cogsBase" IS NULL)::int AS "cogsMissing"
       FROM deals d
      WHERE d."companyId" = $1 AND d."stage" = 'won' AND (d."adCampaignId" = $2`;
  const params: unknown[] = [companyId, campaign.id];
  if (canAutoMatch) {
    attrSql +=
      ` OR (d."adCampaignId" IS NULL AND EXISTS (
            SELECT 1 FROM lead_sources ls
             WHERE ls."dealId" = d."id" AND ls."companyId" = $1
               AND ls."campaignId" = $3 AND ls."source" = ANY($4)))`;
    params.push(campaign.externalId, sources);
  }
  attrSql += `)`;
  const attrRows = (await prisma.$queryRawUnsafe(attrSql, ...params)) as Array<Record<string, unknown>>;
  const a = attrRows[0] ?? {};
  const dealsWon = Number(a.dealsWon ?? 0);
  const revenueBase = round2(toNum(a.revenueBase));
  const revenueUnstamped = Number(a.revenueUnstamped ?? 0);
  const cogsBase = round2(toNum(a.cogsBase));
  const cogsMissing = Number(a.cogsMissing ?? 0);

  // ── Leads (informational) ──
  let leadsCount = 0;
  if (canAutoMatch) {
    const leadRows = (await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS c FROM lead_sources
        WHERE "companyId" = $1 AND "campaignId" = $2 AND "source" = ANY($3)`,
      companyId,
      campaign.externalId,
      sources
    )) as Array<{ c: number }>;
    leadsCount = Number(leadRows[0]?.c ?? 0);
  }

  const netProfit = round2(revenueBase - spendBase - cogsBase);
  const roas = spendBase > 0 ? round2(revenueBase / spendBase) : null;
  const cpa = dealsWon > 0 ? round2(spendBase / dealsWon) : null;
  const marginPct = revenueBase > 0 ? round2((netProfit / revenueBase) * 100) : null;

  return {
    baseCurrency,
    spendBase,
    spendEntryCount,
    spendUnconverted,
    spendComplete: spendUnconverted === 0,
    revenueBase,
    dealsWon,
    revenueUnstamped,
    revenueComplete: revenueUnstamped === 0,
    leadsCount,
    cogsBase,
    cogsMissing,
    cogsComplete: cogsMissing === 0,
    netProfit,
    roas,
    cpa,
    marginPct,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Alerts (Phase D) — ROAS-drop / CPA-rise sweep (cron-driven)
// ──────────────────────────────────────────────────────────────────────

// Re-alert cooldown: a given campaign won't re-fire the same alert kind more
// than once per this window, so a daily sweep of a still-breaching campaign
// stays to one in-app ping a day (dedup is read off the notifications table —
// no extra schema). Notification copy follows the existing English convention
// (same as the SLA-breach notification).
const ALERT_COOLDOWN_HOURS = 24;

async function recentlyAlerted(companyId: string, kind: string, campaignId: string): Promise<boolean> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT 1 FROM notifications
      WHERE "companyId" = $1 AND kind = $2 AND "entityId" = $3
        AND "createdAt" > NOW() - ($4 * INTERVAL '1 hour') LIMIT 1`,
    companyId,
    kind,
    campaignId,
    ALERT_COOLDOWN_HOURS
  )) as Array<unknown>;
  return rows.length > 0;
}

/**
 * Sweep every alerts-enabled campaign with a threshold set and notify the
 * company's owners/managers when ROAS drops below targetRoas or CPA rises above
 * targetCpa. Per-company gated by `campaign_economics` (cached). Cumulative
 * threshold comparison (v1); deduped per kind via the notifications table so a
 * daily sweep doesn't spam. Returns scan/alert counts for logging.
 */
export async function sweepCampaignAlerts(): Promise<{ scanned: number; alerted: number }> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT ${CAMPAIGN_COLS} FROM ad_campaigns
      WHERE "alertsEnabled" = true
        AND ("targetRoas" IS NOT NULL OR "targetCpa" IS NOT NULL)
      ORDER BY "companyId"`
  )) as Array<Record<string, unknown>>;
  const campaigns = rows.map(mapCampaign);

  const entitledCache = new Map<string, boolean>();
  const baseCache = new Map<string, string>();
  const managersCache = new Map<string, string[]>();
  let alerted = 0;

  for (const c of campaigns) {
    // Per-company entitlement gate (cached).
    let entitled = entitledCache.get(c.companyId);
    if (entitled === undefined) {
      entitled = await isEnabled(c.companyId, "campaign_economics");
      entitledCache.set(c.companyId, entitled);
    }
    if (!entitled) continue;

    let base = baseCache.get(c.companyId);
    if (base === undefined) {
      base = await getBaseCurrency(c.companyId);
      baseCache.set(c.companyId, base);
    }

    const ec = await computeCampaignEconomics(c.companyId, c, base);
    // ROAS/CPA are only meaningful once there's spend.
    if (ec.spendBase <= 0) continue;

    const breaches: Array<{ kind: string; title: string; body: string }> = [];
    if (c.targetRoas != null && ec.roas != null && ec.roas < c.targetRoas) {
      breaches.push({
        kind: "campaign_roas_drop",
        title: `ROAS dropped — ${c.name}`,
        body: `ROAS ${ec.roas}× is below your ${c.targetRoas}× target (spend ${ec.spendBase} ${base}, revenue ${ec.revenueBase} ${base}).`,
      });
    }
    if (c.targetCpa != null && ec.cpa != null && ec.cpa > c.targetCpa) {
      breaches.push({
        kind: "campaign_cpa_rise",
        title: `CPA rose — ${c.name}`,
        body: `CPA ${ec.cpa} ${base} is above your ${c.targetCpa} ${base} target (${ec.dealsWon} won from ${ec.spendBase} ${base}).`,
      });
    }
    if (breaches.length === 0) continue;

    // Recipients = active owners/admins/managers (cached per company).
    let managers = managersCache.get(c.companyId);
    if (managers === undefined) {
      const mrows = (await prisma.$queryRawUnsafe(
        `SELECT id FROM users WHERE "companyId" = $1 AND status = 'active' AND role IN ('owner','admin','manager')`,
        c.companyId
      )) as Array<{ id: string }>;
      managers = mrows.map((m) => m.id);
      managersCache.set(c.companyId, managers);
    }
    if (managers.length === 0) continue;

    for (const b of breaches) {
      if (await recentlyAlerted(c.companyId, b.kind, c.id)) continue;
      await createBulkNotifications(c.companyId, managers, {
        kind: b.kind,
        title: b.title,
        body: b.body,
        link: `/ad-campaigns/${c.id}`,
        entityType: "ad_campaign",
        entityId: c.id,
      });
      alerted++;
    }
  }

  return { scanned: campaigns.length, alerted };
}
