// ============================================================================
// WHATSAPP NUMBERS SERVICE — phone_number_id ↔ company mapping (raw SQL)
// ----------------------------------------------------------------------------
// App-level webhooks arrive with a phone_number_id, not a company. A company
// "claims" the configured number once; the webhook resolves the tenant here.
// ============================================================================

import { randomUUID } from "crypto";
import { prisma } from "../../config/database";

export interface WhatsappNumberRow {
  id: string;
  companyId: string;
  phoneNumberId: string;
  wabaId: string | null;
  displayPhone: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Resolve the tenant for an inbound webhook by its phone_number_id. */
export async function getCompanyIdByPhoneNumberId(
  phoneNumberId: string
): Promise<string | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT "companyId" FROM whatsapp_numbers WHERE "phoneNumberId" = $1 AND "status" = 'connected' LIMIT 1`,
    phoneNumberId
  )) as Array<{ companyId: string }>;
  return rows[0]?.companyId ?? null;
}

export async function getNumberForCompany(
  companyId: string
): Promise<WhatsappNumberRow | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT "id","companyId","phoneNumberId","wabaId","displayPhone","status","createdAt","updatedAt"
       FROM whatsapp_numbers WHERE "companyId" = $1 ORDER BY "updatedAt" DESC LIMIT 1`,
    companyId
  )) as WhatsappNumberRow[];
  return rows[0] ?? null;
}

/**
 * Claim a phone_number_id for a company (upsert by phoneNumberId). Re-claiming
 * by a different company moves the mapping (last claim wins) — fine for the
 * single-WABA env model.
 */
export async function registerNumber(params: {
  companyId: string;
  phoneNumberId: string;
  wabaId?: string | null;
  displayPhone?: string | null;
}): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO whatsapp_numbers ("id","companyId","phoneNumberId","wabaId","displayPhone","status","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,'connected',NOW(),NOW())
     ON CONFLICT ("phoneNumberId") DO UPDATE SET
       "companyId"=EXCLUDED."companyId","wabaId"=EXCLUDED."wabaId",
       "displayPhone"=EXCLUDED."displayPhone","status"='connected',"updatedAt"=NOW()`,
    randomUUID(),
    params.companyId,
    params.phoneNumberId,
    params.wabaId ?? null,
    params.displayPhone ?? null
  );
}

export async function removeNumberForCompany(companyId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `DELETE FROM whatsapp_numbers WHERE "companyId" = $1`,
    companyId
  );
}
