import jwt from "jsonwebtoken";
import { env } from "../config/env";
import type {
  AccessTokenPayload,
  RefreshTokenPayload,
} from "../types";

// ============================================================================
// JWT UTILITIES
// ============================================================================

const ACCESS_SECRET = env.JWT_ACCESS_SECRET;
const REFRESH_SECRET = env.JWT_REFRESH_SECRET;

// ─────────────────────────────────────────────────────────────────────────
// Generate Access Token (short-lived: 15m by default)
// ─────────────────────────────────────────────────────────────────────────
// Optional expiresIn override lets specific flows (e.g. admin "Remember me")
// issue a 30-day token without changing the platform default.
export function generateAccessToken(
  payload: Omit<AccessTokenPayload, "type">,
  options?: { expiresIn?: string }
): string {
  return jwt.sign(
    { ...payload, type: "access" },
    ACCESS_SECRET,
    { expiresIn: options?.expiresIn ?? env.JWT_ACCESS_EXPIRES_IN } as jwt.SignOptions
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Generate Refresh Token (long-lived: 7d)
// ─────────────────────────────────────────────────────────────────────────
export function generateRefreshToken(
  payload: Omit<RefreshTokenPayload, "type">
): string {
  return jwt.sign(
    { ...payload, type: "refresh" },
    REFRESH_SECRET,
    { expiresIn: env.JWT_REFRESH_EXPIRES_IN } as jwt.SignOptions
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Verify Access Token
// ─────────────────────────────────────────────────────────────────────────
export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, ACCESS_SECRET) as AccessTokenPayload;
    if (decoded.type !== "access") {
      throw new Error("Invalid token type");
    }
    return decoded;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new Error("TOKEN_EXPIRED");
    }
    if (error instanceof jwt.JsonWebTokenError) {
      throw new Error("INVALID_TOKEN");
    }
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Verify Refresh Token
// ─────────────────────────────────────────────────────────────────────────
export function verifyRefreshToken(token: string): RefreshTokenPayload {
  try {
    const decoded = jwt.verify(token, REFRESH_SECRET) as RefreshTokenPayload;
    if (decoded.type !== "refresh") {
      throw new Error("Invalid token type");
    }
    return decoded;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new Error("REFRESH_TOKEN_EXPIRED");
    }
    if (error instanceof jwt.JsonWebTokenError) {
      throw new Error("INVALID_REFRESH_TOKEN");
    }
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Parse expires-in string to milliseconds (for cookie maxAge)
// Examples: "15m" → 900000, "7d" → 604800000
// ─────────────────────────────────────────────────────────────────────────
export function parseExpiresIn(str: string): number {
  const match = str.match(/^(\d+)([smhd])$/);
  if (!match) return 0;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "d":
      return value * 24 * 60 * 60 * 1000;
    default:
      return 0;
  }
}

// Get access token expiry in seconds (for client)
export const accessTokenExpiresInSeconds = Math.floor(
  parseExpiresIn(env.JWT_ACCESS_EXPIRES_IN) / 1000
);

// ─────────────────────────────────────────────────────────────────────────
// 2FA CHALLENGE TOKENS
// ----------------------------------------------------------------------------
// Issued after a successful password check when the user has 2FA enabled.
// This token is ONLY valid for POST /api/auth/2fa-challenge — it cannot be
// used for any other API call, because verifyAccessToken rejects any token
// whose type isn't "access". Short-lived (5 min) so an intercepted one
// expires quickly.
// ─────────────────────────────────────────────────────────────────────────

interface TwoFactorChallengePayload {
  userId: string;
  type: "2fa_challenge";
  iat?: number;
  exp?: number;
}

export function generate2FAChallengeToken(userId: string): string {
  return jwt.sign(
    { userId, type: "2fa_challenge" } as TwoFactorChallengePayload,
    ACCESS_SECRET,
    { expiresIn: "5m" } as jwt.SignOptions
  );
}

export function verify2FAChallengeToken(token: string): TwoFactorChallengePayload {
  try {
    const decoded = jwt.verify(token, ACCESS_SECRET) as TwoFactorChallengePayload;
    if (decoded.type !== "2fa_challenge") {
      throw new Error("Invalid token type");
    }
    return decoded;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new Error("2FA_CHALLENGE_EXPIRED");
    }
    throw new Error("INVALID_2FA_CHALLENGE");
  }
}