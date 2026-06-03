// ============================================================================
// META LEAD PAGES SERVICE — page_id ↔ company mapping + sealed Page token
// ----------------------------------------------------------------------------
// The `leadgen` webhook arrives with a page_id, not a company. A company
// "claims" a Page once; the webhook resolves the tenant here. The Page access
// token (if stored per-Page) is sealed at rest with tokenCipher (AES-256-GCM).
// ============================================================================

import { randomUUID } from "crypto";
import { prisma } from "../../config/database";
import { encryptToken, decryptToken, isTokenCipherConfigured } from "../../lib/crypto/tokenCipher";
import { getDefaultPageToken } from "./config";

export interface MetaLeadPageRow {
  id: string;
  companyId: string;
  pageId: string;
  pageName: string | null;
  tokenCiphertext: string | null;
  tokenIv: string | null;
  tokenTag: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Resolve the tenant for an inbound leadgen webhook by its page_id. */
export async function getCompanyIdByPageId(pageId: string): Promise<string | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT "companyId" FROM meta_lead_pages WHERE "pageId" = $1 AND "status" = 'connected' LIMIT 1`,
    pageId
  )) as Array<{ companyId: string }>;
  return rows[0]?.companyId ?? null;
}

export async function getPageById(pageId: string): Promise<MetaLeadPageRow | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT "id","companyId","pageId","pageName","tokenCiphertext","tokenIv","tokenTag","status","createdAt","updatedAt"
       FROM meta_lead_pages WHERE "pageId" = $1 LIMIT 1`,
    pageId
  )) as MetaLeadPageRow[];
  return rows[0] ?? null;
}

export async function getPageForCompany(companyId: string): Promise<MetaLeadPageRow | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT "id","companyId","pageId","pageName","tokenCiphertext","tokenIv","tokenTag","status","createdAt","updatedAt"
       FROM meta_lead_pages WHERE "companyId" = $1 ORDER BY "updatedAt" DESC LIMIT 1`,
    companyId
  )) as MetaLeadPageRow[];
  return rows[0] ?? null;
}

/**
 * Resolve the Page access token to use for a Graph fetch: prefer the per-Page
 * sealed token, fall back to the env-level default (single-Page MVP). Returns
 * null when neither is available (caller throws META_LEAD_TOKEN_EXPIRED).
 */
export async function resolvePageToken(pageId: string): Promise<string | null> {
  const page = await getPageById(pageId);
  if (page?.tokenCiphertext && page.tokenIv && page.tokenTag && isTokenCipherConfigured()) {
    try {
      return decryptToken({
        ciphertext: page.tokenCiphertext,
        iv: page.tokenIv,
        tag: page.tokenTag,
      });
    } catch {
      // sealed token unreadable (key rotated/tampered) — fall through to default
    }
  }
  return getDefaultPageToken() ?? null;
}

/**
 * Claim a page_id for a company (upsert by pageId). When `pageToken` is given
 * and the cipher is configured, it is sealed at rest; otherwise token columns
 * are left null and the env-level default token is used at fetch time.
 */
export async function registerPage(params: {
  companyId: string;
  pageId: string;
  pageName?: string | null;
  pageToken?: string | null;
}): Promise<void> {
  let ciphertext: string | null = null;
  let iv: string | null = null;
  let tag: string | null = null;
  if (params.pageToken && isTokenCipherConfigured()) {
    const sealed = encryptToken(params.pageToken);
    ciphertext = sealed.ciphertext;
    iv = sealed.iv;
    tag = sealed.tag;
  }
  await prisma.$executeRawUnsafe(
    `INSERT INTO meta_lead_pages ("id","companyId","pageId","pageName","tokenCiphertext","tokenIv","tokenTag","status","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,'connected',NOW(),NOW())
     ON CONFLICT ("pageId") DO UPDATE SET
       "companyId"=EXCLUDED."companyId","pageName"=EXCLUDED."pageName",
       "tokenCiphertext"=COALESCE(EXCLUDED."tokenCiphertext", meta_lead_pages."tokenCiphertext"),
       "tokenIv"=COALESCE(EXCLUDED."tokenIv", meta_lead_pages."tokenIv"),
       "tokenTag"=COALESCE(EXCLUDED."tokenTag", meta_lead_pages."tokenTag"),
       "status"='connected',"updatedAt"=NOW()`,
    randomUUID(),
    params.companyId,
    params.pageId,
    params.pageName ?? null,
    ciphertext,
    iv,
    tag
  );
}

export async function removePageForCompany(companyId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `DELETE FROM meta_lead_pages WHERE "companyId" = $1`,
    companyId
  );
}
