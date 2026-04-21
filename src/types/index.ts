import type { Request } from "express";

// ============================================================================
// AUTHENTICATED REQUEST
// ============================================================================
// Extends Express Request with authenticated user info.
// Used in route handlers that require authentication.
// ============================================================================

export type UserRole = "super_admin" | "owner" | "admin" | "manager" | "member";

export interface AuthUser {
  userId: string;
  companyId: string;
  email: string;
  role: UserRole;
}

export interface AuthenticatedRequest extends Request {
  user: AuthUser;
}

// ============================================================================
// JWT PAYLOADS
// ============================================================================

export interface AccessTokenPayload {
  userId: string;
  companyId: string;
  email: string;
  role: string;
  type: "access";
}

export interface RefreshTokenPayload {
  userId: string;
  tokenId: string;
  type: "refresh";
}

// ============================================================================
// API RESPONSES
// ============================================================================

export interface ApiSuccess<T = unknown> {
  success: true;
  data: T;
  message?: string;
}

export interface ApiError {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiError;

// ============================================================================
// AUTH DTOs
// ============================================================================

export interface SignupDto {
  companyName: string;
  fullName: string;
  email: string;
  password: string;
  phone?: string;
}

export interface SigninDto {
  email: string;
  password: string;
}

export interface RefreshTokenDto {
  refreshToken: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AuthResponse {
  user: {
    id: string;
    email: string;
    fullName: string;
    role: string;
    companyId: string;
    emailVerified: boolean;
  };
  company: {
    id: string;
    name: string;
    slug: string;
    plan: string;
    country?: string | null;
    baseCurrency?: string | null;
  };
  tokens: AuthTokens;
}