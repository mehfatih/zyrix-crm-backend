// ============================================================================
// TWO-FACTOR AUTHENTICATION (TOTP)
// ----------------------------------------------------------------------------
// Implements RFC 6238 TOTP using the `speakeasy` library (already in
// dependencies). The enrolment flow uses a two-step commit so a user can't
// accidentally lock themselves out:
//
//   1. POST /api/2fa/begin-enroll
//      → backend generates a secret, stores it as PENDING (twoFactorSecret
//        set, twoFactorEnabled still false), returns QR-code data URL + the
//        secret (so desktop users can type it in if scanning fails).
//
//   2. POST /api/2fa/confirm-enroll { code }
//      → user enters the 6-digit code from their authenticator. We verify
//        it against the pending secret. Only if it matches do we flip
//        twoFactorEnabled=true AND generate 10 backup codes (shown once,
//        never recoverable afterwards).
//
// The verification step also accepts the previous 30-second window so
// devices with slight clock skew don't fail the first try.
// ============================================================================

import speakeasy from "speakeasy";
import QRCode from "qrcode";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { prisma } from "../config/database";
import { notFound, AppError } from "../middleware/errorHandler";

const ISSUER = "Zyrix CRM";
const BACKUP_CODE_COUNT = 10;

// ──────────────────────────────────────────────────────────────────────
// ENROLMENT
// ──────────────────────────────────────────────────────────────────────

export async function beginEnroll(
  userId: string
): Promise<{ qrDataUrl: string; secret: string; otpauthUrl: string }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, twoFactorEnabled: true },
  });
  if (!user) throw notFound("User not found");
  if (user.twoFactorEnabled) {
    throw new AppError(
      "Two-factor authentication is already enabled. Disable it first to re-enrol.",
      409,
      "2FA_ALREADY_ENABLED"
    );
  }

  // Generate a new base32 secret. Speakeasy's default 20-byte length is
  // the RFC recommendation.
  const secret = speakeasy.generateSecret({
    length: 20,
    name: `${ISSUER}:${user.email}`,
    issuer: ISSUER,
  });

  // Persist as pending — will be promoted to enabled once the user
  // confirms with a valid code.
  await prisma.user.update({
    where: { id: user.id },
    data: { twoFactorSecret: secret.base32 },
  });

  // Build a QR code image (data URL) that any TOTP app (Google
  // Authenticator, Authy, 1Password, etc.) can scan.
  const otpauthUrl = secret.otpauth_url || "";
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl, {
    errorCorrectionLevel: "M",
    width: 256,
    margin: 1,
  });

  return {
    qrDataUrl,
    secret: secret.base32,
    otpauthUrl,
  };
}

/**
 * Verify the user's first TOTP code. On success, promote 2FA to enabled
 * and generate + return backup codes (shown ONCE — never recoverable).
 */
export async function confirmEnroll(
  userId: string,
  code: string
): Promise<{ enabled: true; backupCodes: string[] }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      twoFactorSecret: true,
      twoFactorEnabled: true,
    },
  });
  if (!user) throw notFound("User not found");
  if (user.twoFactorEnabled) {
    throw new AppError(
      "2FA is already enabled",
      409,
      "2FA_ALREADY_ENABLED"
    );
  }
  if (!user.twoFactorSecret) {
    throw new AppError(
      "No pending 2FA enrolment. Call begin-enroll first.",
      400,
      "NO_PENDING_2FA"
    );
  }

  const ok = speakeasy.totp.verify({
    secret: user.twoFactorSecret,
    encoding: "base32",
    token: code.replace(/\s+/g, ""),
    window: 1, // accept ±30s skew
  });
  if (!ok) {
    throw new AppError(
      "Incorrect code. Please check your authenticator and try again.",
      400,
      "INVALID_2FA_CODE"
    );
  }

  // Generate + hash backup codes
  const plainCodes: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    const plain = generateBackupCode();
    plainCodes.push(plain);
    hashes.push(await bcrypt.hash(plain, 10));
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      twoFactorEnabled: true,
      twoFactorBackupCodes: hashes,
    },
  });

  return { enabled: true, backupCodes: plainCodes };
}

/**
 * Disable 2FA. Requires current password (caller must enforce that
 * before calling this service).
 */
export async function disable(userId: string): Promise<{ disabled: true }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, twoFactorEnabled: true },
  });
  if (!user) throw notFound("User not found");
  if (!user.twoFactorEnabled) {
    return { disabled: true }; // idempotent
  }
  await prisma.user.update({
    where: { id: user.id },
    data: {
      twoFactorEnabled: false,
      twoFactorSecret: null,
      twoFactorBackupCodes: [],
    },
  });
  return { disabled: true };
}

/**
 * Regenerate backup codes. Invalidates the old ones and returns 10 new
 * plain codes (shown once). Only valid for users who already have 2FA
 * enabled.
 */
export async function regenerateBackupCodes(
  userId: string
): Promise<{ backupCodes: string[] }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, twoFactorEnabled: true },
  });
  if (!user) throw notFound("User not found");
  if (!user.twoFactorEnabled) {
    throw new AppError(
      "2FA must be enabled before generating backup codes",
      400,
      "2FA_NOT_ENABLED"
    );
  }

  const plainCodes: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    const plain = generateBackupCode();
    plainCodes.push(plain);
    hashes.push(await bcrypt.hash(plain, 10));
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { twoFactorBackupCodes: hashes },
  });

  return { backupCodes: plainCodes };
}

// ──────────────────────────────────────────────────────────────────────
// LOGIN-TIME VERIFICATION
// ──────────────────────────────────────────────────────────────────────

/**
 * Called during login after password check, when user.twoFactorEnabled
 * is true. Returns { ok: true } if the code matches either a TOTP or
 * a backup code. Backup code matches consume the code (single-use).
 */
export async function verifyLoginCode(
  userId: string,
  code: string
): Promise<{ ok: boolean; usedBackupCode?: boolean }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      twoFactorSecret: true,
      twoFactorBackupCodes: true,
      twoFactorEnabled: true,
    },
  });
  if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) {
    return { ok: false };
  }

  const cleanCode = code.replace(/\s+/g, "").replace(/-/g, "");

  // Try TOTP first (the common case — the user just opened their app)
  const totpOk = speakeasy.totp.verify({
    secret: user.twoFactorSecret,
    encoding: "base32",
    token: cleanCode,
    window: 1,
  });
  if (totpOk) return { ok: true };

  // TOTP failed — try backup codes. These are hashed, so we bcrypt.compare
  // against each until a match is found, then remove that code so it
  // can't be reused.
  for (let i = 0; i < user.twoFactorBackupCodes.length; i++) {
    const hash = user.twoFactorBackupCodes[i];
    const match = await bcrypt.compare(cleanCode, hash);
    if (match) {
      const remaining = user.twoFactorBackupCodes.filter((_, idx) => idx !== i);
      await prisma.user.update({
        where: { id: user.id },
        data: { twoFactorBackupCodes: remaining },
      });
      return { ok: true, usedBackupCode: true };
    }
  }

  return { ok: false };
}

// ──────────────────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────────────────

/**
 * Generate a backup code formatted as XXXX-XXXX (8 hex chars + dash).
 * Uses crypto.randomBytes so codes can't be predicted from prior ones.
 */
function generateBackupCode(): string {
  const bytes = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `${bytes.slice(0, 4)}-${bytes.slice(4, 8)}`;
}

/**
 * Query whether a user has 2FA enabled. Used by the login flow to
 * decide whether to gate the JWT issuance on a TOTP challenge.
 */
export async function is2FAEnabled(userId: string): Promise<boolean> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { twoFactorEnabled: true },
  });
  return u?.twoFactorEnabled ?? false;
}
