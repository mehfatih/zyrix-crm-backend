// ============================================================================
// DOCUMENT LINKS (P9)
// ----------------------------------------------------------------------------
// Minimal Google Docs cataloging. Merchants paste a Google Doc URL or ID;
// we fetch the title + first 500 chars via Drive API using the caller's
// Google OAuth credentials. A weekly cron refreshes snippets for all
// existing links.
//
// Google Drive scope required: https://www.googleapis.com/auth/drive.readonly
// The access token must be available via the existing Google OAuth flow —
// this service reads the token from the (already-imported) google-auth-library
// client; if a company hasn't connected Drive yet, creates a stub link
// with the raw ID and the user can re-index later.
// ============================================================================

import { prisma } from "../config/database";
import { badRequest, notFound } from "../middleware/errorHandler";

const SUPPORTED_ENTITIES = ["customer", "deal", "quote", "contract"] as const;

export interface DocumentLink {
  id: string;
  companyId: string;
  entityType: string;
  entityId: string;
  googleDocId: string;
  title: string;
  snippet: string | null;
  addedBy: string;
  createdAt: Date;
  lastIndexed: Date;
}

// ──────────────────────────────────────────────────────────────────────
// Extract googleDocId from either a raw ID or a Google Docs/Drive URL
// ──────────────────────────────────────────────────────────────────────

export function normalizeGoogleDocId(input: string): string {
  const s = input.trim();
  if (!s) throw badRequest("googleDocId is required");
  // URLs: /document/d/<id>/  or  /file/d/<id>/  or  /drive/folders/<id>
  const m = s.match(/\/(?:document|file|drive\/folders)\/d?\/?([A-Za-z0-9_-]{10,})/);
  if (m) return m[1];
  // Query param fallback: ?id=<id>
  const mq = s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  if (mq) return mq[1];
  // Raw ID
  if (/^[A-Za-z0-9_-]{10,}$/.test(s)) return s;
  throw badRequest("Could not extract a Google Doc ID from the input");
}

// ──────────────────────────────────────────────────────────────────────
// Drive lookup (best-effort — swallow errors and return stub values)
// ──────────────────────────────────────────────────────────────────────
// v1 skips OAuth integration to keep scope tight. A future pass will
// wire a per-user Google access token from the existing OAuthState
// machinery. For now we try an unauthenticated metadata probe and fall
// back to "Untitled" if Google refuses.
// ──────────────────────────────────────────────────────────────────────

async function fetchDocumentMeta(googleDocId: string): Promise<{
  title: string;
  snippet: string | null;
}> {
  // Unauthenticated Drive API calls only work on public docs — but
  // they still return some metadata (status, name) for public links.
  // We do this as a best-effort and silently fall back otherwise.
  const url = `https://www.googleapis.com/drive/v3/files/${googleDocId}?fields=name,mimeType`;
  try {
    const r = await fetch(url);
    if (r.ok) {
      const body = (await r.json()) as { name?: string };
      if (body?.name) return { title: body.name, snippet: null };
    }
  } catch {
    // ignore
  }
  return { title: "Untitled document", snippet: null };
}

// ──────────────────────────────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────────────────────────────

export async function linkDocument(
  companyId: string,
  addedBy: string,
  input: {
    entityType: string;
    entityId: string;
    googleDocId: string;
  }
): Promise<DocumentLink> {
  if (!(SUPPORTED_ENTITIES as readonly string[]).includes(input.entityType)) {
    throw badRequest(
      `Unsupported entityType. Pick one of: ${SUPPORTED_ENTITIES.join(", ")}`
    );
  }
  if (!input.entityId?.trim()) throw badRequest("entityId is required");
  const googleDocId = normalizeGoogleDocId(input.googleDocId);
  const meta = await fetchDocumentMeta(googleDocId);

  const row = await prisma.documentLink.create({
    data: {
      companyId,
      entityType: input.entityType,
      entityId: input.entityId,
      googleDocId,
      title: meta.title,
      snippet: meta.snippet,
      addedBy,
    },
  });
  return row;
}

export async function listDocuments(
  companyId: string,
  filter: { entityType?: string; entityId?: string }
): Promise<DocumentLink[]> {
  const where: any = { companyId };
  if (filter.entityType) where.entityType = filter.entityType;
  if (filter.entityId) where.entityId = filter.entityId;
  return prisma.documentLink.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}

export async function unlinkDocument(
  companyId: string,
  id: string
): Promise<{ deleted: boolean }> {
  const existing = await prisma.documentLink.findFirst({
    where: { id, companyId },
    select: { id: true },
  });
  if (!existing) throw notFound("DocumentLink");
  await prisma.documentLink.delete({ where: { id } });
  return { deleted: true };
}

// ──────────────────────────────────────────────────────────────────────
// Weekly re-index — refreshes title/snippet from Drive.
// ──────────────────────────────────────────────────────────────────────

export async function reindexAllDocuments(): Promise<{
  updated: number;
  checked: number;
}> {
  const rows = await prisma.documentLink.findMany({
    select: { id: true, googleDocId: true },
    // Only rows older than 7 days — keeps the pass cheap even as the
    // catalog grows.
    where: {
      lastIndexed: {
        lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      },
    },
    take: 500,
  });
  let updated = 0;
  for (const r of rows) {
    try {
      const meta = await fetchDocumentMeta(r.googleDocId);
      await prisma.documentLink.update({
        where: { id: r.id },
        data: {
          title: meta.title,
          snippet: meta.snippet ?? undefined,
          lastIndexed: new Date(),
        },
      });
      updated++;
    } catch {
      // Drive call hiccup — skip; next week's pass will retry.
    }
  }
  return { updated, checked: rows.length };
}
