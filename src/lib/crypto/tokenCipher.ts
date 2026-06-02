// ============================================================================
// TOKEN CIPHER — AES-256-GCM encryption for integration secrets at rest
// ----------------------------------------------------------------------------
// Used to encrypt Shopify access/refresh tokens before they touch the DB.
// The key comes from INTEGRATION_TOKEN_ENC_KEY (32 bytes, base64).
//
// SECURITY:
//  • Each encryption uses a fresh random 12-byte IV (GCM standard).
//  • The 16-byte auth tag is stored alongside the ciphertext so decryption
//    can detect tampering (throws on mismatch).
//  • Plaintext tokens are NEVER logged. Callers must not log the return of
//    decrypt() either.
//  • We return hex strings for compact, DB-friendly storage.
// ============================================================================

import crypto from "crypto";
import { env } from "../../config/env";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce — GCM recommended size
const KEY_BYTES = 32; // AES-256

export interface SealedToken {
  ciphertext: string; // hex
  iv: string; // hex
  tag: string; // hex
}

let cachedKey: Buffer | null = null;

/**
 * Resolve and validate the 32-byte encryption key. Throws a clear error if
 * the env var is missing or the wrong length so misconfiguration fails loudly
 * at first use (callers translate this into a typed CONFIG error).
 */
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = env.INTEGRATION_TOKEN_ENC_KEY;
  if (!raw) {
    throw new Error(
      "INTEGRATION_TOKEN_ENC_KEY is not configured — cannot encrypt integration tokens"
    );
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new Error("INTEGRATION_TOKEN_ENC_KEY is not valid base64");
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `INTEGRATION_TOKEN_ENC_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}). Generate with: openssl rand -base64 32`
    );
  }
  cachedKey = key;
  return key;
}

/** True when a valid encryption key is configured. */
export function isTokenCipherConfigured(): boolean {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}

/** Encrypt a plaintext token. Returns hex ciphertext/iv/tag. */
export function encryptToken(plaintext: string): SealedToken {
  const key = getKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("hex"),
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
  };
}

/**
 * Decrypt a sealed token. Throws if the key is wrong, the data was tampered
 * with, or any field is missing. Never log the returned value.
 */
export function decryptToken(sealed: SealedToken): string {
  const key = getKey();
  if (!sealed.ciphertext || !sealed.iv || !sealed.tag) {
    throw new Error("decryptToken: incomplete sealed token");
  }
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(sealed.iv, "hex")
  );
  decipher.setAuthTag(Buffer.from(sealed.tag, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "hex")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
