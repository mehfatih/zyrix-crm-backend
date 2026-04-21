import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as authService from "../services/auth.service";
import * as googleService from "../services/google-oauth.service";
import type { AuthenticatedRequest } from "../types";
import { prisma } from "../config/database";
import { notFound } from "../middleware/errorHandler";
import { recordAudit, extractRequestMeta } from "../utils/audit";

// ============================================================================
// AUTH CONTROLLER
// ============================================================================

// ─────────────────────────────────────────────────────────────────────────
// Validation Schemas
// ─────────────────────────────────────────────────────────────────────────
const signupSchema = z.object({
  companyName: z.string().min(2, "Company name must be at least 2 characters").max(100),
  fullName: z.string().min(2, "Full name must be at least 2 characters").max(100),
  email: z.string().email("Invalid email format"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  phone: z.string().optional(),
});

const signinSchema = z.object({
  email: z.string().email("Invalid email format"),
  password: z.string().min(1, "Password is required"),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token is required"),
});

const googleAuthSchema = z.object({
  idToken: z.string().min(10, "Google ID token is required"),
});

const twoFactorChallengeSchema = z.object({
  challengeToken: z.string().min(10),
  code: z.string().min(6).max(12),
});

const verifyEmailSchema = z.object({
  token: z.string().min(10, "Verification token is required"),
});

const resendVerificationSchema = z.object({
  email: z.string().email("Invalid email format"),
});

const requestPasswordResetSchema = z.object({
  email: z.string().email("Invalid email format"),
});

const resetPasswordSchema = z.object({
  token: z.string().min(10, "Reset token is required"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

// ─────────────────────────────────────────────────────────────────────────
// POST /api/auth/signup
// ─────────────────────────────────────────────────────────────────────────

const updateProfileSchema = z.object({
  fullName: z.string().min(2).max(100).optional(),
  phone: z.string().optional(),
});

const updateCompanySchema = z.object({
  name: z.string().min(2).max(100).optional(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: z.string().min(8, "New password must be at least 8 characters"),
});

export async function signup(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const dto = signupSchema.parse(req.body);
    const result = await authService.signup(dto);

    res.status(201).json({
      success: true,
      data: result,
      message: "Account created. Please verify your email.",
    });
  } catch (error) {
    next(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/auth/signin
// ─────────────────────────────────────────────────────────────────────────
export async function signin(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const meta = extractRequestMeta(req);
  try {
    const dto = signinSchema.parse(req.body);
    const result = await authService.signin(dto);

    // Audit — record the success, but only for a fully-completed login.
    // If 2FA is required, we record success at the challenge step instead.
    if (!("requires2FA" in result) || !result.requires2FA) {
      const r = result as Exclude<typeof result, { requires2FA: true }>;
      await recordAudit({
        userId: r.user.id,
        companyId: r.user.companyId,
        action: "user.login",
        ...meta,
      });
    }

    res.status(200).json({
      success: true,
      data: result,
      message:
        "requires2FA" in result && result.requires2FA
          ? "Two-factor authentication required"
          : "Signed in successfully",
    });
  } catch (error: any) {
    // Log the attempt — but we don't know the userId for a bad-password
    // try since the user lookup failed. Record the email as metadata so
    // ops can still detect credential-stuffing patterns.
    const email =
      typeof req.body?.email === "string" ? req.body.email : null;
    await recordAudit({
      action: "user.login_failed",
      metadata: { email },
      ...meta,
    });
    next(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/auth/2fa-challenge
// ─────────────────────────────────────────────────────────────────────────
export async function twoFactorChallenge(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const meta = extractRequestMeta(req);
  try {
    const { challengeToken, code } = twoFactorChallengeSchema.parse(req.body);
    const result = await authService.complete2FAChallenge(
      challengeToken,
      code
    );
    await recordAudit({
      userId: result.user.id,
      companyId: result.user.companyId,
      action: "user.login",
      metadata: { with2FA: true },
      ...meta,
    });
    res.status(200).json({
      success: true,
      data: result,
      message: "Signed in successfully",
    });
  } catch (error) {
    await recordAudit({
      action: "user.2fa_challenge_failed",
      ...meta,
    });
    next(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/auth/google
// ─────────────────────────────────────────────────────────────────────────
export async function googleAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { idToken } = googleAuthSchema.parse(req.body);
    const result = await googleService.googleSignInOrSignUp(idToken);

    res.status(200).json({
      success: true,
      data: result,
      message: "Signed in with Google successfully",
    });
  } catch (error) {
    next(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/auth/refresh
// ─────────────────────────────────────────────────────────────────────────
export async function refresh(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { refreshToken } = refreshSchema.parse(req.body);
    const tokens = await authService.refresh(refreshToken);

    res.status(200).json({
      success: true,
      data: tokens,
      message: "Tokens refreshed successfully",
    });
  } catch (error) {
    next(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/auth/logout
// ─────────────────────────────────────────────────────────────────────────
export async function logout(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { refreshToken } = refreshSchema.parse(req.body);
    await authService.logout(refreshToken);

    res.status(200).json({
      success: true,
      data: null,
      message: "Logged out successfully",
    });
  } catch (error) {
    next(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/auth/verify-email
// ─────────────────────────────────────────────────────────────────────────
export async function verifyEmail(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { token } = verifyEmailSchema.parse(req.body);
    const result = await authService.verifyEmail(token);

    res.status(200).json({
      success: true,
      data: result,
      message: "Email verified successfully",
    });
  } catch (error) {
    next(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/auth/resend-verification
// ─────────────────────────────────────────────────────────────────────────
export async function resendVerification(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { email } = resendVerificationSchema.parse(req.body);
    const result = await authService.resendVerification(email);

    res.status(200).json({
      success: true,
      data: result,
      message: "Verification email sent",
    });
  } catch (error) {
    next(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/auth/request-password-reset
// ─────────────────────────────────────────────────────────────────────────
export async function requestPasswordReset(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { email } = requestPasswordResetSchema.parse(req.body);
    const result = await authService.requestPasswordReset(email);

    res.status(200).json({
      success: true,
      data: result,
      message: "If an account exists for this email, a reset link was sent.",
    });
  } catch (error) {
    next(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/auth/reset-password
// ─────────────────────────────────────────────────────────────────────────
export async function resetPassword(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { token, password } = resetPasswordSchema.parse(req.body);
    const result = await authService.resetPassword(token, password);

    res.status(200).json({
      success: true,
      data: result,
      message: "Password reset successfully",
    });
  } catch (error) {
    next(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/auth/me
// ─────────────────────────────────────────────────────────────────────────
export async function me(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const user = await prisma.user.findUnique({
      where: { id: authReq.user.userId },
      include: { company: true },
    });

    if (!user) {
      throw notFound("User");
    }

    res.status(200).json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          phone: user.phone,
          role: user.role,
          emailVerified: user.emailVerified,
          twoFactorEnabled: user.twoFactorEnabled,
          lastLoginAt: user.lastLoginAt,
          createdAt: user.createdAt,
        },
        company: {
          id: user.company.id,
          name: user.company.name,
          slug: user.company.slug,
          plan: user.company.plan,
          country: user.company.country,
          baseCurrency: user.company.baseCurrency,
        },
      },
    });
  } catch (error) {
    next(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// PROFILE MANAGEMENT HANDLERS
// ─────────────────────────────────────────────────────────────────────────

export async function updateProfile(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const data = updateProfileSchema.parse(req.body);
    const result = await authService.updateProfile(authReq.user.userId, data);
    res.json({
      success: true,
      data: result,
      message: "Profile updated successfully",
    });
  } catch (error) {
    next(error);
  }
}

export async function updateCompany(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const data = updateCompanySchema.parse(req.body);
    const result = await authService.updateCompany(
      authReq.user.companyId,
      authReq.user.role,
      data
    );
    res.json({
      success: true,
      data: result,
      message: "Company updated successfully",
    });
  } catch (error) {
    next(error);
  }
}

export async function changePassword(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const data = changePasswordSchema.parse(req.body);
    await authService.changePassword(authReq.user.userId, data);
    res.json({
      success: true,
      data: { changed: true },
      message: "Password changed successfully. Please sign in again on other devices.",
    });
  } catch (error) {
    next(error);
  }
}

