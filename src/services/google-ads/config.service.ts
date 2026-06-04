// ============================================================================
// GOOGLE ADS LEAD FORMS — CONFIG SERVICE
// ----------------------------------------------------------------------------
// One config row per company (google_ads_configs). The webhookKey is the shared
// secret Google echoes back as `google_key` on every lead POST. It is SEALED at
// rest with tokenCipher (AES-256-GCM, same as Meta Page tokens) and decrypted
// for: (a) display in the settings UI (copy button) and (b) constant-time
// comparison when a webhook arrives. It is NEVER hashed (the UI must show it
// again) and NEVER logged.
// ============================================================================

import crypto from "crypto";
import { prisma } from "../../config/database";
import {
  encryptToken,
  decryptToken,
  isTokenCipherConfigured,
} from "../../lib/crypto/tokenCipher";

export interface GoogleAdsConfigView {
  companyId: string;
  webhookKey: string; // decrypted — only returned to the authed owner
  mapping: Record<string, string> | null;
  defaultPipelineStage: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Generate a fresh URL-safe 32-char webhook key. */
function generateKey(): string {
  return crypto.randomBytes(24).toString("base64url"); // 24 bytes → 32 chars
}

/** Seal a plaintext key with tokenCipher. Throws if the cipher isn't configured. */
function sealKey(plaintext: string): { ciphertext: string; iv: string; tag: string } {
  if (!isTokenCipherConfigured()) {
    throw new Error(
      "INTEGRATION_TOKEN_ENC_KEY is not configured — cannot seal the Google Ads webhook key"
    );
  }
  return encryptToken(plaintext);
}

/** Decrypt a sealed key. Returns null if the sealed value is unreadable. */
function openKey(row: {
  webhookKeyCiphertext: string;
  webhookKeyIv: string;
  webhookKeyTag: string;
}): string | null {
  try {
    return decryptToken({
      ciphertext: row.webhookKeyCiphertext,
      iv: row.webhookKeyIv,
      tag: row.webhookKeyTag,
    });
  } catch {
    return null;
  }
}

function asMapping(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Get the company's config WITH the decrypted key, creating one (with a fresh
 * sealed key) on first access. Only ever called for the authenticated owner.
 */
export async function getOrCreateConfig(companyId: string): Promise<GoogleAdsConfigView> {
  const existing = await prisma.googleAdsConfig.findUnique({ where: { companyId } });
  if (existing) {
    let webhookKey = openKey(existing);
    if (!webhookKey) {
      // Sealed key unreadable (cipher key rotated/tampered) — reseal a new one
      // so the integration keeps working rather than silently failing.
      webhookKey = generateKey();
      const sealed = sealKey(webhookKey);
      await prisma.googleAdsConfig.update({
        where: { companyId },
        data: {
          webhookKeyCiphertext: sealed.ciphertext,
          webhookKeyIv: sealed.iv,
          webhookKeyTag: sealed.tag,
        },
      });
    }
    return {
      companyId: existing.companyId,
      webhookKey,
      mapping: asMapping(existing.mapping),
      defaultPipelineStage: existing.defaultPipelineStage,
      status: existing.status,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
    };
  }

  const webhookKey = generateKey();
  const sealed = sealKey(webhookKey);
  const created = await prisma.googleAdsConfig.create({
    data: {
      companyId,
      webhookKeyCiphertext: sealed.ciphertext,
      webhookKeyIv: sealed.iv,
      webhookKeyTag: sealed.tag,
    },
  });
  return {
    companyId: created.companyId,
    webhookKey,
    mapping: null,
    defaultPipelineStage: null,
    status: created.status,
    createdAt: created.createdAt,
    updatedAt: created.updatedAt,
  };
}

/** Rotate the webhook key. Returns the new config view (with the new key). */
export async function rotateKey(companyId: string): Promise<GoogleAdsConfigView> {
  await getOrCreateConfig(companyId); // ensure a row exists
  const webhookKey = generateKey();
  const sealed = sealKey(webhookKey);
  const updated = await prisma.googleAdsConfig.update({
    where: { companyId },
    data: {
      webhookKeyCiphertext: sealed.ciphertext,
      webhookKeyIv: sealed.iv,
      webhookKeyTag: sealed.tag,
    },
  });
  return {
    companyId: updated.companyId,
    webhookKey,
    mapping: asMapping(updated.mapping),
    defaultPipelineStage: updated.defaultPipelineStage,
    status: updated.status,
    createdAt: updated.createdAt,
    updatedAt: updated.updatedAt,
  };
}

export interface UpdateConfigInput {
  mapping?: Record<string, string> | null;
  defaultPipelineStage?: string | null;
  status?: string;
}

/** Update editable config fields (mapping, default stage, status). */
export async function updateConfig(
  companyId: string,
  input: UpdateConfigInput
): Promise<GoogleAdsConfigView> {
  await getOrCreateConfig(companyId);
  const data: Record<string, unknown> = {};
  if (input.mapping !== undefined) data.mapping = input.mapping ?? null;
  if (input.defaultPipelineStage !== undefined)
    data.defaultPipelineStage = input.defaultPipelineStage?.trim() || null;
  if (input.status !== undefined && (input.status === "active" || input.status === "disabled"))
    data.status = input.status;

  const updated = Object.keys(data).length
    ? await prisma.googleAdsConfig.update({ where: { companyId }, data })
    : await prisma.googleAdsConfig.findUniqueOrThrow({ where: { companyId } });

  const webhookKey = openKey(updated) ?? "";
  return {
    companyId: updated.companyId,
    webhookKey,
    mapping: asMapping(updated.mapping),
    defaultPipelineStage: updated.defaultPipelineStage,
    status: updated.status,
    createdAt: updated.createdAt,
    updatedAt: updated.updatedAt,
  };
}

export interface ResolvedConfig {
  companyId: string;
  mapping: Record<string, string> | null;
  defaultPipelineStage: string | null;
  status: string;
}

/**
 * Verify an inbound `google_key` against the company's sealed webhook key using
 * a constant-time comparison. Returns the resolved config when valid (and the
 * integration is active), else null. Never throws.
 */
export async function verifyKeyAndResolve(
  companyId: string,
  providedKey: string | undefined | null
): Promise<ResolvedConfig | null> {
  if (!providedKey || typeof providedKey !== "string") return null;
  const row = await prisma.googleAdsConfig.findUnique({ where: { companyId } });
  if (!row) return null;
  const expected = openKey(row);
  if (!expected) return null;

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(providedKey, "utf8");
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  if (row.status !== "active") return null;

  return {
    companyId: row.companyId,
    mapping: asMapping(row.mapping),
    defaultPipelineStage: row.defaultPipelineStage,
    status: row.status,
  };
}
