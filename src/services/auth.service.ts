import { v4 as uuidv4 } from "uuid";
import { randomBytes } from "crypto";
import { prisma } from "../config/database";
import { hashPassword, comparePassword, validatePasswordStrength } from "../utils/password";
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  accessTokenExpiresInSeconds,
  generate2FAChallengeToken,
  verify2FAChallengeToken,
} from "../utils/jwt";
import { badRequest, conflict, unauthorized, notFound } from "../middleware/errorHandler";
import {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendWelcomeEmail,
} from "./email.service";
import { env } from "../config/env";
import { verifyLoginCode } from "./twofactor.service";
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

  // Generate verification token
  const verificationToken = randomBytes(32).toString("hex");
  const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

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
        emailVerificationToken: verificationToken,
        emailVerificationExpires: verificationExpires,
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

  // Send verification + welcome emails (fire and forget)
  const verificationUrl = `${env.FRONTEND_URL}/en/verify-email?token=${verificationToken}`;
  sendVerificationEmail(
    result.user.email,
    result.user.fullName,
    verificationUrl
  ).catch((err) => console.error("[Auth] Verification email failed:", err));

  sendWelcomeEmail(
    result.user.email,
    result.user.fullName,
    result.company.name
  ).catch((err) => console.error("[Auth] Welcome email failed:", err));

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
      country: result.company.country,
      baseCurrency: result.company.baseCurrency,
    },
    tokens,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// SIGNIN — Authenticate existing user
// ─────────────────────────────────────────────────────────────────────────
/**
 * Signin response — if user has 2FA enabled, we return a short-lived
 * challenge token instead of the full JWT pair. The client must then
 * call /api/auth/2fa-challenge with the tempToken + code to complete.
 */
export type SigninResult =
  | (AuthResponse & { requires2FA?: false })
  | { requires2FA: true; challengeToken: string };

export async function signin(dto: SigninDto): Promise<SigninResult> {
  const { email, password } = dto;

  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    include: { company: true },
  });

  if (!user || !user.passwordHash) {
    throw unauthorized("Invalid email or password");
  }

  const isValid = await comparePassword(password, user.passwordHash);
  if (!isValid) {
    throw unauthorized("Invalid email or password");
  }

  // If 2FA is enabled, DO NOT issue the JWT pair yet. Return a short-
  // lived challenge token the client will submit alongside the TOTP
  // code to /api/auth/2fa-challenge. lastLoginAt updates only after
  // the second factor succeeds — otherwise a stolen password would
  // show a fake "last login" timestamp.
  if (user.twoFactorEnabled) {
    return {
      requires2FA: true,
      challengeToken: generate2FAChallengeToken(user.id),
    };
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

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
      country: user.company.country,
      baseCurrency: user.company.baseCurrency,
    },
    tokens,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 2FA CHALLENGE COMPLETION — step 2 of login for users with 2FA on
// ─────────────────────────────────────────────────────────────────────────
export async function complete2FAChallenge(
  challengeToken: string,
  code: string
): Promise<AuthResponse> {
  let payload;
  try {
    payload = verify2FAChallengeToken(challengeToken);
  } catch (e: any) {
    if (e.message === "2FA_CHALLENGE_EXPIRED") {
      throw unauthorized("Challenge expired — please sign in again");
    }
    throw unauthorized("Invalid challenge token");
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    include: { company: true },
  });
  if (!user || !user.twoFactorEnabled) {
    throw unauthorized("Invalid challenge");
  }

  const result = await verifyLoginCode(user.id, code);
  if (!result.ok) {
    throw unauthorized("Incorrect code");
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

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
      country: user.company.country,
      baseCurrency: user.company.baseCurrency,
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

  await prisma.refreshToken.update({
    where: { id: storedToken.id },
    data: { revokedAt: new Date() },
  });

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
    // Silent fail
  }
}

// ─────────────────────────────────────────────────────────────────────────
// VERIFY EMAIL
// ─────────────────────────────────────────────────────────────────────────
export async function verifyEmail(
  token: string
): Promise<{ verified: boolean; email: string }> {
  const user = await prisma.user.findFirst({
    where: {
      emailVerificationToken: token,
      emailVerificationExpires: { gt: new Date() },
    },
  });

  if (!user) {
    throw badRequest("Invalid or expired verification link");
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerified: true,
      emailVerificationToken: null,
      emailVerificationExpires: null,
    },
  });

  return { verified: true, email: user.email };
}

// ─────────────────────────────────────────────────────────────────────────
// RESEND VERIFICATION EMAIL
// ─────────────────────────────────────────────────────────────────────────
export async function resendVerification(
  email: string
): Promise<{ sent: boolean }> {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
  });

  if (!user) {
    throw notFound("User not found");
  }

  if (user.emailVerified) {
    throw badRequest("Email is already verified");
  }

  const verificationToken = randomBytes(32).toString("hex");
  const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerificationToken: verificationToken,
      emailVerificationExpires: verificationExpires,
    },
  });

  const verificationUrl = `${env.FRONTEND_URL}/en/verify-email?token=${verificationToken}`;
  await sendVerificationEmail(user.email, user.fullName, verificationUrl);

  return { sent: true };
}

// ─────────────────────────────────────────────────────────────────────────
// REQUEST PASSWORD RESET
// ─────────────────────────────────────────────────────────────────────────
export async function requestPasswordReset(
  email: string
): Promise<{ sent: boolean }> {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
  });

  // Always return success to prevent email enumeration
  if (!user) {
    return { sent: true };
  }

  const resetToken = randomBytes(32).toString("hex");
  const resetExpires = new Date(Date.now() + 60 * 60 * 1000);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordResetToken: resetToken,
      passwordResetExpires: resetExpires,
    },
  });

  const resetUrl = `${env.FRONTEND_URL}/en/reset-password?token=${resetToken}`;
  await sendPasswordResetEmail(user.email, user.fullName, resetUrl).catch(
    (err) => console.error("[Auth] Password reset email failed:", err)
  );

  return { sent: true };
}

// ─────────────────────────────────────────────────────────────────────────
// RESET PASSWORD
// ─────────────────────────────────────────────────────────────────────────
export async function resetPassword(
  token: string,
  newPassword: string
): Promise<{ reset: boolean }> {
  // Validate password strength
  const validation = validatePasswordStrength(newPassword);
  if (!validation.valid) {
    throw badRequest("Password is too weak", validation.errors);
  }

  const user = await prisma.user.findFirst({
    where: {
      passwordResetToken: token,
      passwordResetExpires: { gt: new Date() },
    },
  });

  if (!user) {
    throw badRequest("Invalid or expired reset link");
  }

  const passwordHash = await hashPassword(newPassword);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      passwordResetToken: null,
      passwordResetExpires: null,
    },
  });

  // Revoke all refresh tokens for this user
  await prisma.refreshToken.updateMany({
    where: { userId: user.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  return { reset: true };
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


// ─────────────────────────────────────────────────────────────────────────
// PROFILE MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────

export interface UpdateProfileDto {
  fullName?: string;
  phone?: string;
}

export async function updateProfile(
  userId: string,
  dto: UpdateProfileDto
): Promise<{ user: any }> {
  const updateData: any = {};
  if (dto.fullName !== undefined) updateData.fullName = dto.fullName;
  if (dto.phone !== undefined) updateData.phone = dto.phone;

  if (Object.keys(updateData).length === 0) {
    throw badRequest("No fields to update", "NO_FIELDS");
  }

  updateData.updatedAt = new Date();

  const user = await prisma.user.update({
    where: { id: userId },
    data: updateData,
    select: {
      id: true,
      email: true,
      fullName: true,
      phone: true,
      role: true,
      companyId: true,
      emailVerified: true,
      twoFactorEnabled: true,
      lastLoginAt: true,
      createdAt: true,
    },
  });

  return { user };
}

export interface UpdateCompanyDto {
  name?: string;
}

export async function updateCompany(
  companyId: string,
  userRole: string,
  dto: UpdateCompanyDto
): Promise<{ company: any }> {
  if (userRole !== "owner" && userRole !== "admin") {
    throw unauthorized("Only owners and admins can update company settings");
  }

  const updateData: any = {};
  if (dto.name !== undefined) updateData.name = dto.name;

  if (Object.keys(updateData).length === 0) {
    throw badRequest("No fields to update", "NO_FIELDS");
  }

  updateData.updatedAt = new Date();

  const company = await prisma.company.update({
    where: { id: companyId },
    data: updateData,
    select: {
      id: true,
      name: true,
      slug: true,
      plan: true,
    },
  });

  return { company };
}

export interface ChangePasswordDto {
  currentPassword: string;
  newPassword: string;
}

export async function changePassword(
  userId: string,
  dto: ChangePasswordDto
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, passwordHash: true, email: true, fullName: true },
  });

  if (!user) {
    throw notFound("User");
  }

  if (!user.passwordHash) {
    throw badRequest("This account uses Google Sign-in. Password cannot be changed.", "GOOGLE_ACCOUNT");
  }

  const valid = await comparePassword(dto.currentPassword, user.passwordHash);
  if (!valid) {
    throw badRequest("Current password is incorrect", "INVALID_PASSWORD");
  }

  if (dto.newPassword.length < 8) {
    throw badRequest("New password must be at least 8 characters", "WEAK_PASSWORD");
  }

  const newHash = await hashPassword(dto.newPassword);

  await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash: newHash,
      updatedAt: new Date(),
    },
  });

  // Invalidate all refresh tokens so user must sign in again on other devices
  await prisma.refreshToken.deleteMany({
    where: { userId },
  });
}

