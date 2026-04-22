import { v4 as uuidv4 } from "uuid";
import { prisma } from "../config/database";
import { comparePassword } from "../utils/password";
import {
  generateAccessToken,
  generateRefreshToken,
  accessTokenExpiresInSeconds,
  parseExpiresIn,
} from "../utils/jwt";
import { unauthorized, forbidden } from "../middleware/errorHandler";
import { env } from "../config/env";
import { recordAudit } from "../utils/audit";
import type { AuthTokens, SigninDto } from "../types";

// Extended access-token lifetime when the admin opts into "Remember me".
const REMEMBER_ME_ACCESS_EXPIRES_IN = "30d";
const REMEMBER_ME_ACCESS_SECONDS = Math.floor(
  parseExpiresIn(REMEMBER_ME_ACCESS_EXPIRES_IN) / 1000
);

// ============================================================================
// ADMIN AUTH SERVICE
// ============================================================================
// Separate login flow for super_admin role.
// Endpoint: POST /api/admin/login
// ============================================================================

export interface AdminLoginResponse {
  user: {
    id: string;
    email: string;
    fullName: string;
    role: string;
  };
  tokens: AuthTokens;
}

export async function adminSignin(dto: SigninDto): Promise<AdminLoginResponse> {
  const email = dto.email.toLowerCase().trim();

  // Find user
  const user = await prisma.user.findUnique({
    where: { email },
  });

  if (!user) {
    throw unauthorized("Invalid credentials");
  }

  // Must be super_admin
  if (user.role !== "super_admin") {
    throw forbidden("This login is for super administrators only");
  }

  // Must be active
  if (user.status !== "active") {
    throw forbidden("Admin account is disabled");
  }

  // Must have password
  if (!user.passwordHash) {
    throw unauthorized("Invalid credentials");
  }

  // Verify password
  const passwordMatches = await comparePassword(dto.password, user.passwordHash);
  if (!passwordMatches) {
    throw unauthorized("Invalid credentials");
  }

  const rememberMe = dto.rememberMe === true;

  // Generate tokens
  const tokenId = uuidv4();
  const accessToken = generateAccessToken(
    {
      userId: user.id,
      companyId: user.companyId,
      email: user.email,
      role: user.role,
    },
    rememberMe ? { expiresIn: REMEMBER_ME_ACCESS_EXPIRES_IN } : undefined
  );
  const refreshToken = generateRefreshToken({
    userId: user.id,
    tokenId,
  });

  // Store refresh token
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  await prisma.refreshToken.create({
    data: {
      id: tokenId,
      userId: user.id,
      token: refreshToken,
      expiresAt,
    },
  });

  // Update last login
  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  await recordAudit({
    userId: user.id,
    companyId: user.companyId,
    action: "admin.login",
    entityType: "user",
    entityId: user.id,
    metadata: { rememberMe },
  });

  return {
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
    },
    tokens: {
      accessToken,
      refreshToken,
      expiresIn: rememberMe
        ? REMEMBER_ME_ACCESS_SECONDS
        : accessTokenExpiresInSeconds,
    },
  };
}

// Silence unused env warning
void env;
