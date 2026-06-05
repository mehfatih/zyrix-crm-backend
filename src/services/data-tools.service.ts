// ============================================================================
// DATA TOOLS — dedupe scan + merge + undo (Sprint 13)
// ----------------------------------------------------------------------------
// Merge re-points EVERY reference to a contact (the recon §2.3 touchpoint
// table) inside one transaction, applies field-level winner selection, writes a
// full merge_logs snapshot (incl. the exact moved row ids so undo is precise),
// then soft-deletes the merged contact (deletedAt + mergedIntoId). Undo re-
// points the captured rows back and un-soft-deletes.
//
// Documented limits: rows DELETED to resolve a unique collision (a tag /
// campaign / active-cadence both contacts shared) are not restored on undo;
// references created AFTER the merge stay on the kept contact.
// ============================================================================

import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { prisma } from "../config/database";
import { env } from "../config/env";
import { normalizeE164, dialCodeForCountry } from "./google-ads/map";

const genAI = env.GEMINI_API_KEY ? new GoogleGenerativeAI(env.GEMINI_API_KEY) : null;

// ── normalization (shared philosophy with bonus.detectDuplicateCustomer) ────
function normName(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().trim().replace(/[^a-z0-9؀-ۿ\s]/g, "").replace(/\s+/g, " ");
}
function normPhone(s: string | null | undefined): string {
  const d = (s ?? "").replace(/[^0-9]/g, "");
  return d.length >= 9 ? d.slice(-9) : d; // last-9 like the lead-ingest dedupe
}
function normEmail(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().trim();
}

interface ContactLite {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  whatsappPhone: string | null;
  city: string | null;
  companyName: string | null;
  createdAt: Date;
}

export interface DuplicatePair {
  a: ContactLite;
  b: ContactLite;
  score: number; // 0..1
  reasons: string[];
}

// ── DEDUPE SCAN ──────────────────────────────────────────────────────────────
export async function scanDuplicates(
  companyId: string,
  opts: { page?: number; limit?: number } = {}
): Promise<{ pairs: DuplicatePair[]; total: number; page: number; limit: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.min(50, Math.max(1, opts.limit ?? 20));

  const customers = (await prisma.customer.findMany({
    where: { companyId, deletedAt: null },
    select: {
      id: true, fullName: true, email: true, phone: true, whatsappPhone: true,
      city: true, companyName: true, createdAt: true,
    },
    take: 5000, // safety cap; covers typical SMB books
  })) as ContactLite[];

  // Bucket by exact email, exact phone (last-9), and name-token+city.
  const byEmail = new Map<string, ContactLite[]>();
  const byPhone = new Map<string, ContactLite[]>();
  const byNameCity = new Map<string, ContactLite[]>();
  for (const c of customers) {
    const e = normEmail(c.email);
    if (e) (byEmail.get(e) ?? byEmail.set(e, []).get(e)!).push(c);
    for (const p of [normPhone(c.phone), normPhone(c.whatsappPhone)]) {
      if (p && p.length >= 9) (byPhone.get(p) ?? byPhone.set(p, []).get(p)!).push(c);
    }
    const nm = normName(c.fullName);
    const token = nm.split(" ")[0];
    if (token && c.city) {
      const k = `${token}|${normName(c.city)}`;
      (byNameCity.get(k) ?? byNameCity.set(k, []).get(k)!).push(c);
    }
  }

  const pairMap = new Map<string, DuplicatePair>();
  const keyOf = (x: string, y: string) => (x < y ? `${x}:${y}` : `${y}:${x}`);
  const addPair = (a: ContactLite, b: ContactLite, score: number, reason: string) => {
    if (a.id === b.id) return;
    const k = keyOf(a.id, b.id);
    const existing = pairMap.get(k);
    if (existing) {
      existing.score = Math.min(1, Math.max(existing.score, score));
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
    } else {
      const [pa, pb] = a.id < b.id ? [a, b] : [b, a];
      pairMap.set(k, { a: pa, b: pb, score, reasons: [reason] });
    }
  };

  const eachInBucket = (buckets: Map<string, ContactLite[]>, score: number, reason: (k: string) => string) => {
    for (const [k, list] of buckets) {
      if (list.length < 2) continue;
      // de-dup list by id (a contact can appear twice via phone+whatsapp)
      const uniq = Array.from(new Map(list.map((c) => [c.id, c])).values());
      for (let i = 0; i < uniq.length; i++)
        for (let j = i + 1; j < uniq.length; j++) addPair(uniq[i], uniq[j], score, reason(k));
    }
  };

  eachInBucket(byEmail, 0.95, () => "same email");
  eachInBucket(byPhone, 0.9, () => "same phone");
  // Name+city is weaker — boost when the full normalized names also match.
  for (const [, list] of byNameCity) {
    if (list.length < 2) continue;
    const uniq = Array.from(new Map(list.map((c) => [c.id, c])).values());
    for (let i = 0; i < uniq.length; i++)
      for (let j = i + 1; j < uniq.length; j++) {
        const exact = normName(uniq[i].fullName) === normName(uniq[j].fullName);
        addPair(uniq[i], uniq[j], exact ? 0.7 : 0.5, exact ? "same name + city" : "similar name + city");
      }
  }

  const all = Array.from(pairMap.values()).sort((x, y) => y.score - x.score);
  const total = all.length;
  const start = (page - 1) * limit;
  return { pairs: all.slice(start, start + limit), total, page, limit };
}

// ── AI VERDICT (on demand, per pair) ──────────────────────────────────────────
const VERDICT_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    sameEntity: { type: SchemaType.BOOLEAN },
    confidence: { type: SchemaType.NUMBER },
    reason: { type: SchemaType.STRING },
  },
  required: ["sameEntity", "confidence", "reason"],
} as const;

export async function aiVerdict(
  companyId: string,
  idA: string,
  idB: string
): Promise<{ sameEntity: boolean; confidence: number; reason: string }> {
  const [a, b] = await Promise.all([
    prisma.customer.findFirst({ where: { id: idA, companyId, deletedAt: null } }),
    prisma.customer.findFirst({ where: { id: idB, companyId, deletedAt: null } }),
  ]);
  if (!a || !b) throw Object.assign(new Error("Contact not found"), { statusCode: 404 });
  if (!genAI) return { sameEntity: false, confidence: 0, reason: "AI not configured" };

  const fields = (c: any) => ({
    fullName: c.fullName, email: c.email, phone: c.phone, whatsappPhone: c.whatsappPhone,
    companyName: c.companyName, city: c.city, country: c.country,
  });
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction:
      "You decide if two CRM contact records are the SAME real person/company. Be conservative: only true if the evidence is strong (matching email or phone, or matching name + company/location). Different people who share a first name are NOT the same.",
    generationConfig: { temperature: 0.1, responseMimeType: "application/json", responseSchema: VERDICT_SCHEMA as never },
  });
  try {
    const r = await model.generateContent(
      `Record A: ${JSON.stringify(fields(a))}\nRecord B: ${JSON.stringify(fields(b))}\n\nAre these the same entity? Return JSON.`
    );
    const parsed = JSON.parse(r.response.text());
    return {
      sameEntity: !!parsed.sameEntity,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
      reason: String(parsed.reason || "").slice(0, 400),
    };
  } catch {
    return { sameEntity: false, confidence: 0, reason: "AI verdict unavailable" };
  }
}

// ── MERGE ──────────────────────────────────────────────────────────────────
// Standard id-keyed touchpoints (no unique collision on the FK column).
const STD_TOUCHPOINTS: { table: string; col: string }[] = [
  { table: "deals", col: "customerId" },
  { table: "activities", col: "customerId" },
  { table: "tasks", col: "customerId" },
  { table: "whatsapp_chats", col: "customerId" },
  { table: "quotes", col: "customerId" },
  { table: "loyalty_transactions", col: "customerId" },
  { table: "contracts", col: "customerId" },
  { table: "portal_tokens", col: "customerId" },
  { table: "meetings", col: "customerId" },
  { table: "email_messages", col: "contactId" },
  { table: "conversations", col: "contactId" },
  { table: "contact_channel_identities", col: "contactId" },
  { table: "lead_sources", col: "contactId" },
  { table: "form_submissions", col: "createdContactId" },
];

const MERGEABLE_FIELDS = [
  "fullName", "email", "phone", "whatsappPhone", "companyName", "position",
  "country", "city", "address", "notes", "status", "lifetimeValue",
] as const;

export interface MergeResult {
  logId: string;
  keptContactId: string;
  mergedContactId: string;
  movedCounts: Record<string, number>;
}

export async function mergeContacts(
  companyId: string,
  userId: string,
  input: { keepId: string; mergeId: string; fieldChoices?: Record<string, "keep" | "merge"> }
): Promise<MergeResult> {
  const { keepId, mergeId } = input;
  if (!keepId || !mergeId || keepId === mergeId) {
    throw Object.assign(new Error("keepId and mergeId must differ"), { statusCode: 400 });
  }
  const [keep, merged] = await Promise.all([
    prisma.customer.findFirst({ where: { id: keepId, companyId } }),
    prisma.customer.findFirst({ where: { id: mergeId, companyId } }),
  ]);
  if (!keep || !merged) throw Object.assign(new Error("Contact not found"), { statusCode: 404 });
  if (keep.deletedAt || merged.deletedAt) {
    throw Object.assign(new Error("One of the contacts was already merged"), { statusCode: 409 });
  }

  const fieldChoices = input.fieldChoices ?? {};
  const movedRefs: { table: string; col: string; ids: string[] }[] = [];
  let movedTagIds: string[] = [];
  const movedCounts: Record<string, number> = {};

  const logId = await prisma.$transaction(async (tx) => {
    const ev = (sql: string, ...p: unknown[]) => tx.$executeRawUnsafe(sql, ...p);
    const q = <T>(sql: string, ...p: unknown[]) => tx.$queryRawUnsafe(sql, ...p) as Promise<T>;

    // Standard touchpoints: capture ids → re-point.
    for (const tp of STD_TOUCHPOINTS) {
      const rows = await q<Array<{ id: string }>>(
        `SELECT id FROM ${tp.table} WHERE "${tp.col}" = $1`,
        mergeId
      );
      const ids = rows.map((r) => r.id);
      if (ids.length) {
        await ev(`UPDATE ${tp.table} SET "${tp.col}" = $1 WHERE "${tp.col}" = $2`, keepId, mergeId);
      }
      movedRefs.push({ table: tp.table, col: tp.col, ids });
      movedCounts[tp.table] = ids.length;
    }

    // campaign_recipients — unique(campaignId, customerId): drop merge's dups first.
    await ev(
      `DELETE FROM campaign_recipients WHERE "customerId" = $1 AND "campaignId" IN (SELECT "campaignId" FROM campaign_recipients WHERE "customerId" = $2)`,
      mergeId, keepId
    );
    {
      const rows = await q<Array<{ id: string }>>(`SELECT id FROM campaign_recipients WHERE "customerId" = $1`, mergeId);
      const ids = rows.map((r) => r.id);
      if (ids.length) await ev(`UPDATE campaign_recipients SET "customerId" = $1 WHERE "customerId" = $2`, keepId, mergeId);
      movedRefs.push({ table: "campaign_recipients", col: "customerId", ids });
      movedCounts["campaign_recipients"] = ids.length;
    }

    // cadence_enrollments — partial-unique ACTIVE per (cadenceId, contactId): drop merge's active dups.
    await ev(
      `DELETE FROM cadence_enrollments WHERE "contactId" = $1 AND status = 'active' AND "cadenceId" IN (SELECT "cadenceId" FROM cadence_enrollments WHERE "contactId" = $2 AND status = 'active')`,
      mergeId, keepId
    );
    {
      const rows = await q<Array<{ id: string }>>(`SELECT id FROM cadence_enrollments WHERE "contactId" = $1`, mergeId);
      const ids = rows.map((r) => r.id);
      if (ids.length) await ev(`UPDATE cadence_enrollments SET "contactId" = $1 WHERE "contactId" = $2`, keepId, mergeId);
      movedRefs.push({ table: "cadence_enrollments", col: "contactId", ids });
      movedCounts["cadence_enrollments"] = ids.length;
    }

    // customer_tags — composite PK (customerId, tagId): drop shared tags first.
    await ev(
      `DELETE FROM customer_tags WHERE "customerId" = $1 AND "tagId" IN (SELECT "tagId" FROM customer_tags WHERE "customerId" = $2)`,
      mergeId, keepId
    );
    {
      const rows = await q<Array<{ tagId: string }>>(`SELECT "tagId" FROM customer_tags WHERE "customerId" = $1`, mergeId);
      movedTagIds = rows.map((r) => r.tagId);
      if (movedTagIds.length) await ev(`UPDATE customer_tags SET "customerId" = $1 WHERE "customerId" = $2`, keepId, mergeId);
      movedCounts["customer_tags"] = movedTagIds.length;
    }

    // notifications — polymorphic link (Q3 best-effort).
    {
      const rows = await q<Array<{ id: string }>>(
        `SELECT id FROM notifications WHERE "entityId" = $1 AND "entityType" IN ('customer','contact')`,
        mergeId
      );
      const ids = rows.map((r) => r.id);
      if (ids.length) await ev(`UPDATE notifications SET "entityId" = $1 WHERE "entityId" = $2 AND "entityType" IN ('customer','contact')`, keepId, mergeId);
      movedRefs.push({ table: "notifications", col: "entityId", ids });
      movedCounts["notifications"] = ids.length;
    }

    // Field-level winner: copy merged values onto keep where chosen.
    const data: Record<string, unknown> = {};
    for (const f of MERGEABLE_FIELDS) {
      if (fieldChoices[f] === "merge") data[f] = (merged as any)[f];
    }
    if (Object.keys(data).length) {
      await tx.customer.update({ where: { id: keepId }, data: data as any });
    }

    // Soft-delete the merged contact.
    await tx.customer.update({ where: { id: mergeId }, data: { deletedAt: new Date(), mergedIntoId: keepId } });

    // Snapshot.
    const snapshot = {
      keep, merged, fieldChoices, movedRefs, movedTagIds, movedCounts,
    };
    const log = await tx.mergeLog.create({
      data: {
        companyId, kind: "merge", keptContactId: keepId, mergedContactId: mergeId,
        snapshot: JSON.stringify(snapshot), userId,
      },
    });
    return log.id;
  });

  return { logId, keptContactId: keepId, mergedContactId: mergeId, movedCounts };
}

// ── UNDO MERGE ────────────────────────────────────────────────────────────────
export async function undoMerge(companyId: string, logId: string): Promise<{ restored: string }> {
  const log = await prisma.mergeLog.findFirst({ where: { id: logId, companyId, kind: "merge" } });
  if (!log) throw Object.assign(new Error("Merge log not found"), { statusCode: 404 });
  if (log.undone) throw Object.assign(new Error("Already undone"), { statusCode: 409 });

  let snap: any;
  try { snap = JSON.parse(log.snapshot); } catch { throw Object.assign(new Error("Corrupt snapshot"), { statusCode: 500 }); }
  const keepId = log.keptContactId!;
  const mergeId = log.mergedContactId!;

  await prisma.$transaction(async (tx) => {
    const ev = (sql: string, ...p: unknown[]) => tx.$executeRawUnsafe(sql, ...p);

    // Re-point captured rows back to the merged contact (exact ids only).
    for (const ref of (snap.movedRefs ?? []) as { table: string; col: string; ids: string[] }[]) {
      if (!ref.ids?.length) continue;
      await ev(
        `UPDATE ${ref.table} SET "${ref.col}" = $1 WHERE id = ANY($2::text[])`,
        mergeId, ref.ids
      );
    }
    // customer_tags by tagId.
    if ((snap.movedTagIds ?? []).length) {
      await ev(
        `UPDATE customer_tags SET "customerId" = $1 WHERE "customerId" = $2 AND "tagId" = ANY($3::text[])`,
        mergeId, keepId, snap.movedTagIds
      );
    }
    // Restore keep's overwritten fields from the snapshot.
    const keepData: Record<string, unknown> = {};
    for (const f of MERGEABLE_FIELDS) {
      if (snap.fieldChoices?.[f] === "merge" && snap.keep && f in snap.keep) keepData[f] = snap.keep[f];
    }
    if (Object.keys(keepData).length) {
      await tx.customer.update({ where: { id: keepId }, data: keepData as any });
    }
    // Un-soft-delete the merged contact.
    await tx.customer.update({ where: { id: mergeId }, data: { deletedAt: null, mergedIntoId: null } });
    await tx.mergeLog.update({ where: { id: logId }, data: { undone: true } });
  });

  return { restored: mergeId };
}

// ════════════════════════════════════════════════════════════════════════════
// BULK CLEANUP (Sprint 13 Phase E)
// ── phone→E.164, trim/collapse whitespace, Latin-only name casing, email
//    lowercase. Preview shows before/after; apply snapshots changed values into
//    a merge_logs row (kind='cleanup') for one-click undo. Arabic names are
//    NEVER touched by the casing rule.
// ════════════════════════════════════════════════════════════════════════════
export type CleanupRule = "phone_e164" | "trim_whitespace" | "name_case" | "email_lowercase";

export interface CleanupChange { id: string; field: string; before: string; after: string }

const ARABIC_RE = /[؀-ۿ]/;

function titleCaseLatin(s: string): string {
  // Only re-case ASCII words; leave any token containing non-ASCII letters as-is
  // so Turkish/Arabic/diacritic names aren't mangled.
  return s.split(/(\s+)/).map((tok) => {
    if (!tok.trim()) return tok;
    if (!/^[A-Za-z'’-]+$/.test(tok)) return tok;
    return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
  }).join("");
}
function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

interface CustomerForCleanup {
  id: string; fullName: string; email: string | null; phone: string | null;
  whatsappPhone: string | null; companyName: string | null; city: string | null;
  address: string | null; notes: string | null; country: string | null;
}

function computeChanges(rows: CustomerForCleanup[], rules: Set<CleanupRule>): CleanupChange[] {
  const changes: CleanupChange[] = [];
  const push = (id: string, field: string, before: string | null, after: string) => {
    const b = before ?? "";
    if (after !== b && after.trim() !== "") changes.push({ id, field, before: b, after });
  };
  for (const c of rows) {
    if (rules.has("trim_whitespace")) {
      for (const f of ["fullName", "companyName", "city", "address", "notes"] as const) {
        const v = (c as any)[f] as string | null;
        if (v && collapseWs(v) !== v) push(c.id, f, v, collapseWs(v));
      }
    }
    if (rules.has("name_case") && c.fullName && !ARABIC_RE.test(c.fullName)) {
      const base = rules.has("trim_whitespace") ? collapseWs(c.fullName) : c.fullName;
      const cased = titleCaseLatin(base);
      if (cased !== c.fullName) push(c.id, "fullName", c.fullName, cased);
    }
    if (rules.has("email_lowercase") && c.email) {
      const lc = c.email.trim().toLowerCase();
      if (lc !== c.email) push(c.id, "email", c.email, lc);
    }
    if (rules.has("phone_e164")) {
      const dc = dialCodeForCountry(c.country);
      for (const f of ["phone", "whatsappPhone"] as const) {
        const v = (c as any)[f] as string | null;
        if (!v) continue;
        try {
          const e = normalizeE164(v, dc);
          if (e && e !== v) push(c.id, f, v, e);
        } catch { /* skip unparseable */ }
      }
    }
  }
  return changes;
}

async function loadForCleanup(companyId: string): Promise<CustomerForCleanup[]> {
  return (await prisma.customer.findMany({
    where: { companyId, deletedAt: null },
    select: {
      id: true, fullName: true, email: true, phone: true, whatsappPhone: true,
      companyName: true, city: true, address: true, notes: true, country: true,
    },
    take: 5000,
  })) as CustomerForCleanup[];
}

export async function cleanupPreviewSvc(
  companyId: string,
  rules: CleanupRule[]
): Promise<{ totalAffected: number; sample: CleanupChange[] }> {
  const set = new Set(rules);
  const changes = computeChanges(await loadForCleanup(companyId), set);
  return { totalAffected: changes.length, sample: changes.slice(0, 50) };
}

export async function cleanupApplySvc(
  companyId: string,
  userId: string,
  rules: CleanupRule[]
): Promise<{ logId: string; applied: number }> {
  const set = new Set(rules);
  const changes = computeChanges(await loadForCleanup(companyId), set);
  if (changes.length === 0) {
    const log = await prisma.mergeLog.create({
      data: { companyId, kind: "cleanup", snapshot: JSON.stringify({ changes: [] }), userId },
    });
    return { logId: log.id, applied: 0 };
  }
  // Group changes per customer → one update each.
  const byId = new Map<string, Record<string, string>>();
  for (const ch of changes) {
    const m = byId.get(ch.id) ?? {};
    m[ch.field] = ch.after;
    byId.set(ch.id, m);
  }
  const logId = await prisma.$transaction(async (tx) => {
    for (const [id, data] of byId) {
      await tx.customer.update({ where: { id }, data: data as any });
    }
    const log = await tx.mergeLog.create({
      data: { companyId, kind: "cleanup", snapshot: JSON.stringify({ changes }), userId },
    });
    return log.id;
  });
  return { logId, applied: changes.length };
}

export async function cleanupUndoSvc(companyId: string, logId: string): Promise<{ reverted: number }> {
  const log = await prisma.mergeLog.findFirst({ where: { id: logId, companyId, kind: "cleanup" } });
  if (!log) throw Object.assign(new Error("Cleanup log not found"), { statusCode: 404 });
  if (log.undone) throw Object.assign(new Error("Already undone"), { statusCode: 409 });
  let changes: CleanupChange[] = [];
  try { changes = JSON.parse(log.snapshot)?.changes ?? []; } catch { /* noop */ }
  // Restore before-values, grouped per customer.
  const byId = new Map<string, Record<string, string>>();
  for (const ch of changes) {
    const m = byId.get(ch.id) ?? {};
    m[ch.field] = ch.before;
    byId.set(ch.id, m);
  }
  await prisma.$transaction(async (tx) => {
    for (const [id, data] of byId) {
      // Only revert rows that still exist for this company (skip merged-away).
      await tx.customer.updateMany({ where: { id, companyId }, data: data as any });
    }
    await tx.mergeLog.update({ where: { id: logId }, data: { undone: true } });
  });
  return { reverted: changes.length };
}

export async function listMergeLogs(companyId: string, limit = 20): Promise<Array<{
  id: string; kind: string; keptContactId: string | null; mergedContactId: string | null;
  undone: boolean; createdAt: string; movedCounts: Record<string, number> | null;
}>> {
  const rows = await prisma.mergeLog.findMany({ where: { companyId }, orderBy: { createdAt: "desc" }, take: limit });
  return rows.map((r) => {
    let movedCounts: Record<string, number> | null = null;
    try { movedCounts = JSON.parse(r.snapshot)?.movedCounts ?? null; } catch { /* noop */ }
    return {
      id: r.id, kind: r.kind, keptContactId: r.keptContactId, mergedContactId: r.mergedContactId,
      undone: r.undone, createdAt: r.createdAt.toISOString(), movedCounts,
    };
  });
}
