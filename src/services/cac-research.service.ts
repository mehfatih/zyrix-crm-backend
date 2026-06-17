// ============================================================================
// CAC RESEARCH SERVICE (Sprint 3, Phase 2) — live web-research ENRICHMENT.
// ----------------------------------------------------------------------------
// Populates the `cac_research_cache` table (raw SQL) with real, dated case-study
// / example citations that DECORATE the existing rule-based CAC recommendations.
//
// ISOLATION + HALLUCINATION FIREWALL (locked, non-negotiable):
//   • This module is NEVER imported by cac-forecast.service / cac.service. It is
//     a self-contained side-channel. The recommendations math (benchmarks,
//     personalized levers, forecast) NEVER reads from here.
//   • The READ path (readEnrichment) is a PURE SELECT — it can NEVER trigger a
//     Gemini call. The ONLY writer is the gated weekly cron worker.
//   • Enrichment is DISPLAY TEXT + citation links ONLY. No value from here ever
//     enters any CAC/forecast/benchmark figure. We require non-empty grounding
//     (a real search actually ran) before keeping any item, so we never surface
//     ungrounded, hallucinated content.
//
// GEMINI CLIENT (deliberately NOT the shared ai.service client): the installed
// @google/generative-ai@0.24.1 SDK does NOT type the 2.x `googleSearch` grounding
// tool (only the retired 1.5 `googleSearchRetrieval`). So we call the v1beta REST
// generateContent endpoint directly via native fetch with tools:[{google_search:{}}],
// reusing GEMINI_API_KEY. This keeps the shared client + its convention untouched
// and sandboxes all grounding here.
//
// ToS (Gemini "Grounding with Google Search"): a grounded result must be shown
// WITH its Google Search Suggestions. We cache searchEntryPoint.renderedContent
// so the page renders the chip (sandboxed) alongside the enrichment (Phase 2B).
//
// SCOPE: allowlist ONLY — 5 PLAYBOOK_LEVERS topics × 3 benchmark industry bands,
// EN-only (translation deferred). No tenant free-text ever enters the prompt.
// ============================================================================

import { randomUUID } from "crypto";
import { prisma } from "../config/database";
import { env } from "../config/env";
import { INDUSTRY_BENCHMARKS, DEFAULT_BENCHMARK, PLAYBOOK_LEVERS } from "./cac-benchmarks";

// ── Tunables (cost + safety caps) ──────────────────────────────────────────
const GROUNDING_MODEL = "gemini-2.5-flash";
const GENERATE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GROUNDING_MODEL}:generateContent`;
const MODEL_TAG = `${GROUNDING_MODEL}+google_search`;
const MAX_ITEMS = 3; // top N citations kept per cell
const MAX_SUMMARY_CHARS = 320; // clamp each summary
const TTL_DAYS = 10; // > the weekly cron, so a single skipped run never empties cache
const FETCH_TIMEOUT_MS = 30_000;
const LOCALE = "en"; // v1 is EN-only

// The fixed allowlist matrix. Industry bands come from the SAME benchmark source
// the recommendations use; topics are the SAME PLAYBOOK_LEVERS ids. 3 × 5 = 15
// rows for the whole platform (shared across tenants of an industry band).
const BANDS = [...INDUSTRY_BENCHMARKS, DEFAULT_BENCHMARK].map((b) => ({ key: b.key, label: b.label.en }));
const TOPICS = PLAYBOOK_LEVERS.map((l) => ({ id: l.id, title: l.title.en, body: l.body.en }));

// ── Public shapes (also consumed by Phase 2B's recommendations wiring) ──────
export interface EnrichmentItem {
  title: string;
  summary: string;
  sourceUrl: string;
  sourceTitle: string;
  publishedDate: string | null; // YYYY or YYYY-MM, null when unknown (never fabricated)
  attribution: string; // "per <sourceTitle>, <date>" — how any figure-bearing text is labeled
}

export interface EnrichmentRow {
  topic: string;
  items: EnrichmentItem[];
  searchEntryPoint: string | null; // Google Suggestions HTML (rendered sandboxed in 2B)
  status: string; // 'ok' | 'stale' | 'error'
  fetchedAt: Date;
  expiresAt: Date;
  stale: boolean; // status !== 'ok' OR expired
}

// ── Gemini REST response (minimal, defensive typing) ────────────────────────
interface GWeb {
  uri?: string;
  title?: string;
}
interface GChunk {
  web?: GWeb;
}
interface GMeta {
  groundingChunks?: GChunk[];
  searchEntryPoint?: { renderedContent?: string };
}
interface GPart {
  text?: string;
}
interface GCandidate {
  content?: { parts?: GPart[] };
  groundingMetadata?: GMeta;
}
interface GResponse {
  candidates?: GCandidate[];
}

interface FetchedCell {
  items: EnrichmentItem[];
  searchEntryPoint: string | null;
}

// ─────────────────────────────────────────────────────────────────────────
// READ (pure SELECT) — Phase 2B reads this to decorate recommendations. There
// is NO fetch-if-missing branch: a cache miss simply yields no enrichment, so
// /cac degrades to byte-identical Phase-1 output.
// ─────────────────────────────────────────────────────────────────────────
function parsePayload(raw: unknown): EnrichmentItem[] {
  let arr: unknown = raw;
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({
      title: String(x.title ?? ""),
      summary: String(x.summary ?? ""),
      sourceUrl: String(x.sourceUrl ?? ""),
      sourceTitle: String(x.sourceTitle ?? ""),
      publishedDate: x.publishedDate == null ? null : String(x.publishedDate),
      attribution: String(x.attribution ?? ""),
    }))
    .filter((i) => i.title && i.sourceUrl);
}

export async function readEnrichment(
  industryKey: string,
  locale: string = LOCALE
): Promise<Map<string, EnrichmentRow>> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT "topic","payload","searchEntryPoint","status","fetchedAt","expiresAt"
       FROM cac_research_cache
      WHERE "industryKey" = $1 AND "locale" = $2`,
    industryKey,
    locale
  )) as Array<Record<string, unknown>>;

  const now = Date.now();
  const map = new Map<string, EnrichmentRow>();
  for (const r of rows) {
    const expiresAt = r.expiresAt as Date;
    const status = String(r.status ?? "ok");
    map.set(String(r.topic), {
      topic: String(r.topic),
      items: parsePayload(r.payload),
      searchEntryPoint: (r.searchEntryPoint as string | null) ?? null,
      status,
      fetchedAt: r.fetchedAt as Date,
      expiresAt,
      stale: status !== "ok" || (expiresAt instanceof Date && expiresAt.getTime() < now),
    });
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────
// FETCH (live grounded Gemini call) — cron-only. Never called on the read path.
// ─────────────────────────────────────────────────────────────────────────
function buildPrompt(bandLabel: string, topicTitle: string, topicBody: string): string {
  // Allowlist-only: industry band + topic are fixed strings from our own tables.
  // No tenant data, no free text. We explicitly forbid invented sources/dates and
  // authoritative CAC figures (this layer is context, not numbers).
  return [
    `You are compiling sourced, real-world examples for an e-commerce marketing knowledge panel.`,
    `Industry: ${bandLabel}.`,
    `Topic: ${topicTitle} — ${topicBody}`,
    ``,
    `Using web search, find ${MAX_ITEMS} real, recent (prefer the last ~2 years), reputable case studies, articles, or data points that illustrate this topic for this industry.`,
    `Return ONLY a JSON array (no prose, no markdown fences). Each element:`,
    `{"title": string, "summary": string (<= 2 factual sentences), "sourceUrl": string (the real source URL you found), "sourceTitle": string (publication/site name), "publishedDate": string ("YYYY" or "YYYY-MM") or null if unknown}`,
    ``,
    `Rules: Use ONLY real URLs returned by your search. Do NOT invent sources, statistics, or dates — if unsure of a date, use null. Do NOT present any customer-acquisition-cost dollar figure as an authoritative benchmark; keep numbers as quoted context only.`,
  ].join("\n");
}

/** Extract the first JSON array from a model text response (tolerates fences/prose). */
function extractJsonArray(text: string): unknown[] {
  if (!text) return [];
  let t = text.trim();
  // strip ```json ... ``` fences if present
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(t.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isHttpUrl(s: string): boolean {
  return /^https?:\/\/\S+$/i.test(s);
}
function normDate(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return /^\d{4}(-\d{2})?$/.test(s) ? s : null;
}

/** Validate + clamp model items into safe display citations. */
function toItems(rawItems: unknown[]): EnrichmentItem[] {
  const out: EnrichmentItem[] = [];
  for (const x of rawItems) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const sourceUrl = String(o.sourceUrl ?? "").trim();
    const title = String(o.title ?? "").trim();
    if (!isHttpUrl(sourceUrl) || !title) continue; // drop fabricated/blank-URL items
    const sourceTitle = String(o.sourceTitle ?? "").trim() || title;
    const publishedDate = normDate(o.publishedDate);
    let summary = String(o.summary ?? "").trim();
    if (summary.length > MAX_SUMMARY_CHARS) summary = summary.slice(0, MAX_SUMMARY_CHARS).trimEnd() + "…";
    out.push({
      title: title.slice(0, 200),
      summary,
      sourceUrl,
      sourceTitle: sourceTitle.slice(0, 160),
      publishedDate,
      attribution: `per ${sourceTitle.slice(0, 160)}${publishedDate ? `, ${publishedDate}` : ""}`,
    });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

/** One grounded call for a single (industry, topic) cell. Throws on transport /
 *  HTTP / missing-key failure (the cron catches and marks the row stale). */
async function fetchResearchCell(bandLabel: string, topic: { title: string; body: string }): Promise<FetchedCell> {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let json: GResponse;
  try {
    const res = await fetch(`${GENERATE_URL}?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: buildPrompt(bandLabel, topic.title, topic.body) }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.2 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`grounding HTTP ${res.status}`);
    json = (await res.json()) as GResponse;
  } finally {
    clearTimeout(timer);
  }

  const cand = json.candidates?.[0];
  const meta = cand?.groundingMetadata;
  const chunks = meta?.groundingChunks ?? [];
  const searchEntryPoint = meta?.searchEntryPoint?.renderedContent ?? null;

  // FIREWALL: if no grounding chunks came back, no real search backed this answer
  // → keep ZERO items (never surface ungrounded text). We still store an empty row
  // so the cron records the attempt; the page shows Phase-1-only for this topic.
  if (chunks.length === 0) return { items: [], searchEntryPoint: null };

  const text = (cand?.content?.parts ?? []).map((p) => p.text ?? "").join("\n");
  const items = toItems(extractJsonArray(text));
  return { items, searchEntryPoint };
}

// ─────────────────────────────────────────────────────────────────────────
// WRITE (cron-only UPSERT) — keyed (industryKey, topic, locale).
// ─────────────────────────────────────────────────────────────────────────
async function upsertCell(
  industryKey: string,
  topic: string,
  cell: FetchedCell,
  status: "ok" = "ok"
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO cac_research_cache
       ("id","industryKey","topic","locale","payload","searchEntryPoint","model","status","fetchedAt","expiresAt","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,NOW(), NOW() + ($9 || ' days')::interval, NOW(), NOW())
     ON CONFLICT ("industryKey","topic","locale") DO UPDATE SET
       "payload" = EXCLUDED."payload",
       "searchEntryPoint" = EXCLUDED."searchEntryPoint",
       "model" = EXCLUDED."model",
       "status" = EXCLUDED."status",
       "fetchedAt" = EXCLUDED."fetchedAt",
       "expiresAt" = EXCLUDED."expiresAt",
       "updatedAt" = NOW()`,
    randomUUID(),
    industryKey,
    topic,
    LOCALE,
    JSON.stringify(cell.items),
    cell.searchEntryPoint,
    MODEL_TAG,
    status,
    String(TTL_DAYS)
  );
}

/** On a fetch failure, flag the EXISTING row stale (no-op if none) — we never wipe
 *  last-good content and never block. */
async function markStale(industryKey: string, topic: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE cac_research_cache SET "status" = 'stale', "updatedAt" = NOW()
      WHERE "industryKey" = $1 AND "topic" = $2 AND "locale" = $3`,
    industryKey,
    topic,
    LOCALE
  );
}

export interface RefreshResult {
  refreshed: number;
  failed: number;
  skipped: number;
}

/**
 * Refresh the entire allowlist matrix (cron entrypoint). Defense-in-depth: bails
 * unless CAC_RESEARCH_ENABLED === "true" AND a key is present, so it can NEVER make
 * a live call by accident. Per-cell failures are isolated (mark stale, continue);
 * this function never throws.
 */
export async function refreshAllResearch(reason = "manual"): Promise<RefreshResult> {
  const result: RefreshResult = { refreshed: 0, failed: 0, skipped: 0 };
  if (env.CAC_RESEARCH_ENABLED !== "true" || !env.GEMINI_API_KEY) {
    result.skipped = BANDS.length * TOPICS.length;
    return result;
  }
  for (const band of BANDS) {
    for (const topic of TOPICS) {
      try {
        const cell = await fetchResearchCell(band.label, topic);
        await upsertCell(band.key, topic.id, cell);
        result.refreshed += 1;
      } catch (e) {
        result.failed += 1;
        try {
          await markStale(band.key, topic.id);
        } catch {
          /* swallow — never block the sweep */
        }
        console.error(`[cac-research] ${reason} ${band.key}/${topic.id} failed:`, (e as Error).message);
      }
    }
  }
  return result;
}
