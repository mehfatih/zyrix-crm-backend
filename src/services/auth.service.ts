import { v4 as uuidv4 } from "uuid";
import { prisma } from "../config/database";
import { hashPassword, comparePassword, validatePasswordStrength } from "../utils/password";
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  accessTokenExpiresInSeconds,
} from "../utils/jwt";
import { badRequest, conflict, unauthorized } from "../middleware/errorHandler";
import type {
  SignupDto,
  SigninDto,
  AuthResponse,
  AuthTokens,
} from "../types";

// ============================================================================
// AUTH SERVICE
// ============================================================================

// ─────────────────────────────────────────────────────────────────────────
// Slugify helper
// ─────────────────────────────────────────────────────────────────────────
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .substring(0, 50);
}

// ─────────────────────────────────────────────────────────────────────────
// SIGNUP — Create new company + owner user
// ─────────────────────────────────────────────────────────────────────────
export async function signup(dto: SignupDto): Promise<AuthResponse> {
  const { companyName, fullName, email, password, phone } = dto;

  // Validate password strength
  const validation = validatePasswordStrength(password);
  if (!validation.valid) {
    throw badRequest("Password is too weak", validation.errors);
  }

  // Check if email already exists
  const existingUser = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
  });
  if (existingUser) {
    throw conflict("An account with this email already exists");
  }

  // Generate unique company slug
  let slug = slugify(companyName);
  let slugSuffix = 0;
  while (await prisma.company.findUnique({ where: { slug } })) {
    slugSuffix++;
    slug = `${slugify(companyName)}-${slugSuffix}`;
  }

  // Hash password
  const passwordHash = await hashPassword(password);

  // Create company + user in a transaction
  const result = await prisma.$transaction(async (tx) => {
    const company = await tx.company.create({
      data: {
        name: companyName,
        slug,
        plan: "free",
      },
    });

    const user = await tx.user.create({
      data: {
        companyId: company.id,
        email: email.toLowerCase(),
        passwordHash,
        fullName,
        phone,
        role: "owner",
        emailVerified: false,
      },
    });

    return { company, user };
  });

  // Generate tokens
  const tokens = await generateAuthTokens(
    result.user.id,
    result.company.id,
    result.user.email,
    result.user.role
  );

  return {
    user: {
      id: result.user.id,
      email: result.user.email,
      fullName: result.user.fullName,
      role: result.user.role,
      companyId: result.company.id,
      emailVerified: result.user.emailVerified,
    },
    company: {
      id: result.company.id,
      name: result.company.name,
      slug: result.company.slug,
      plan: result.company.plan,
    },
    tokens,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// SIGNIN — Authenticate existing user
// ─────────────────────────────────────────────────────────────────────────
export async function signin(dto: SigninDto): Promise<AuthResponse> {
  const { email, password } = dto;

  // Find user with company
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    include: { company: true },
  });

  if (!user || !user.passwordHash) {
    throw unauthorized("Invalid email or password");
  }

  // Verify password
  const isValid = await comparePassword(password, user.passwordHash);
  if (!isValid) {
    throw unauthorized("Invalid email or password");
  }

  // Update last login
  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  // Generate tokens
  const tokens = await generateAuthTokens(
    user.id,
    user.companyId,
    user.email,
    user.role
  );

  return {
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      companyId: user.companyId,
      emailVerified: user.emailVerified,
    },
    company: {
      id: user.company.id,
      name: user.company.name,
      slug: user.company.slug,
      plan: user.company.plan,
    },
    tokens,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// REFRESH — Issue new access token using refresh token
// ─────────────────────────────────────────────────────────────────────────
export async function refresh(refreshToken: string): Promise<AuthTokens> {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch (error) {
    throw unauthorized("Invalid or expired refresh token");
  }

  // Check if refresh token exists in DB and isn't revoked
  const storedToken = await prisma.refreshToken.findUnique({
    where: { token: refreshToken },
    include: { user: true },
  });

  if (!storedToken || storedToken.revokedAt) {
    throw unauthorized("Refresh token has been revoked");
  }

  if (storedToken.expiresAt < new Date()) {
    throw unauthorized("Refresh token has expired");
  }

  // Revoke the old refresh token (rotation)
  await prisma.refreshToken.update({
    where: { id: storedToken.id },
    data: { revokedAt: new Date() },
  });

  // Generate new tokens
  return generateAuthTokens(
    storedToken.user.id,
    storedToken.user.companyId,
    storedToken.user.email,
    storedToken.user.role
  );
}

// ─────────────────────────────────────────────────────────────────────────
// LOGOUT — Revoke refresh token
// ─────────────────────────────────────────────────────────────────────────
export async function logout(refreshToken: string): Promise<void> {
  try {
    const storedToken = await prisma.refreshToken.findUnique({
      where: { token: refreshToken },
    });
    if (storedToken && !storedToken.revokedAt) {
      await prisma.refreshToken.update({
        where: { id: storedToken.id },
        data: { revokedAt: new Date() },
      });
    }
  } catch {
    // Silent fail — logout should always succeed from client's perspective
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Helper: Generate + store access & refresh tokens
// ─────────────────────────────────────────────────────────────────────────
async function generateAuthTokens(
  userId: string,
  companyId: string,
  email: string,
  role: string
): Promise<AuthTokens> {
  const accessToken = generateAccessToken({
    userId,
    companyId,
    email,
    role,
  });

  const tokenId = uuidv4();
  const refreshToken = generateRefreshToken({
    userId,
    tokenId,
  });

  // Store refresh token in DB (expires in 7 days)
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  await prisma.refreshToken.create({
    data: {
      id: tokenId,
      userId,
      token: refreshToken,
      expiresAt,
    },
  });

  return {
    accessToken,
    refreshToken,
    expiresIn: accessTokenExpiresInSeconds,
  };
}