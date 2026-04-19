import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as authService from "../services/auth.service";
import type { AuthenticatedRequest } from "../types";
import { prisma } from "../config/database";
import { notFound } from "../middleware/errorHandler";

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

// ─────────────────────────────────────────────────────────────────────────
// POST /api/auth/signup
// ─────────────────────────────────────────────────────────────────────────
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
      message: "Account created successfully",
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
  try {
    const dto = signinSchema.parse(req.body);
    const result = await authService.signin(dto);

    res.status(200).json({
      success: true,
      data: result,
      message: "Signed in successfully",
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
// GET /api/auth/me — Get current authenticated user
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
        },
      },
    });
  } catch (error) {
    next(error);
  }
}