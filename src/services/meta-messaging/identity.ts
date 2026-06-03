// ============================================================================
// META MESSAGING — CONTACT CHANNEL IDENTITY (PSID / IGSID)
// ----------------------------------------------------------------------------
// Messenger/Instagram DMs carry no phone/email — a sender is a platform-scoped
// id (PSID for Messenger, IGSID for Instagram). We map that id to a CRM
// contact via contact_channel_identities, creating the customer on first DM.
// Raw SQL (no generated-client dependency), mirroring conversations.service.
// ============================================================================

import { randomUUID } from "crypto";
import { prisma } from "../../config/database";

const CHANNEL_LABEL: Record<string, string> = {
  messenger: "Messenger",
  instagram: "Instagram",
};

/**
 * Resolve (or create) the CRM contact for a platform-scoped sender id.
 * Looks up contact_channel_identities by (company, channel, externalId); on
 * miss, creates a customers row (source=channel) + the identity row. Idempotent
 * via the unique (companyId, channel, externalId) index. Returns the contact id.
 */
export async function findOrCreateContactByChannelIdentity(
  companyId: string,
  channel: string,
  externalId: string,
  profileName?: string | null
): Promise<string> {
  const found = (await prisma.$queryRawUnsafe(
    `SELECT "contactId" FROM contact_channel_identities
      WHERE "companyId" = $1 AND "channel" = $2 AND "externalId" = $3 LIMIT 1`,
    companyId,
    channel,
    externalId
  )) as Array<{ contactId: string }>;
  if (found[0]) {
    // Keep the cached profile name fresh when Graph gives us a better one.
    if (profileName && profileName.trim()) {
      await prisma.$executeRawUnsafe(
        `UPDATE contact_channel_identities SET "profileName" = $1, "updatedAt" = NOW()
          WHERE "companyId" = $2 AND "channel" = $3 AND "externalId" = $4`,
        profileName.trim(),
        companyId,
        channel,
        externalId
      );
    }
    return found[0].contactId;
  }

  const label = CHANNEL_LABEL[channel] ?? channel;
  const fullName = profileName && profileName.trim() ? profileName.trim() : `${label} ${externalId}`;

  const contactId = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO customers ("id","companyId","fullName","source","status","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,'new',NOW(),NOW())`,
    contactId,
    companyId,
    fullName,
    channel
  );

  // Race backstop: if a concurrent webhook retry created the identity first,
  // ON CONFLICT DO NOTHING leaves the existing mapping and we re-read it.
  await prisma.$executeRawUnsafe(
    `INSERT INTO contact_channel_identities
       ("id","companyId","contactId","channel","externalId","profileName","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())
     ON CONFLICT ("companyId","channel","externalId") DO NOTHING`,
    randomUUID(),
    companyId,
    contactId,
    channel,
    externalId,
    profileName && profileName.trim() ? profileName.trim() : null
  );

  const confirm = (await prisma.$queryRawUnsafe(
    `SELECT "contactId" FROM contact_channel_identities
      WHERE "companyId" = $1 AND "channel" = $2 AND "externalId" = $3 LIMIT 1`,
    companyId,
    channel,
    externalId
  )) as Array<{ contactId: string }>;
  // If a concurrent insert won, our orphan customer row is harmless (no
  // identity points to it); return the winning contact.
  return confirm[0]?.contactId ?? contactId;
}
