import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { isDevelopment } from "../config/env";

// ============================================================================
// GLOBAL ERROR HANDLER
// ============================================================================
// Catches all errors thrown in async routes and returns consistent JSON.
// ============================================================================

export class AppError extends Error {
  public statusCode: number;
  public code: string;
  public details?: unknown;

  constructor(
    message: string,
    statusCode: number = 500,
    code: string = "INTERNAL_ERROR",
    details?: unknown
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

// Common error helpers
export const badRequest = (message: string, details?: unknown) =>
  new AppError(message, 400, "BAD_REQUEST", details);

export const unauthorized = (message: string = "Unauthorized") =>
  new AppError(message, 401, "UNAUTHORIZED");

export const forbidden = (message: string = "Forbidden") =>
  new AppError(message, 403, "FORBIDDEN");

export const notFound = (resource: string = "Resource") =>
  new AppError(`${resource} not found`, 404, "NOT_FOUND");

export const conflict = (message: string) =>
  new AppError(message, 409, "CONFLICT");

export const validationError = (details: unknown) =>
  new AppError("Validation failed", 422, "VALIDATION_ERROR", details);

// ─────────────────────────────────────────────────────────────────────────
// Main Error Handler
// ─────────────────────────────────────────────────────────────────────────
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  // Log error in development
  if (isDevelopment) {
    console.error("[ERROR]", {
      url: req.url,
      method: req.method,
      error: err.message,
      stack: err.stack,
    });
  }

  // Zod validation errors
  if (err instanceof ZodError) {
    res.status(422).json({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        details: err.errors.map((e) => ({
          path: e.path.join("."),
          message: e.message,
        })),
      },
    });
    return;
  }

  // Custom AppError
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
    return;
  }

  // Prisma errors (common ones)
  if (err.message.includes("Unique constraint")) {
    res.status(409).json({
      success: false,
      error: {
        code: "DUPLICATE_ENTRY",
        message: "A record with this value already exists",
      },
    });
    return;
  }

  // Unknown errors
  res.status(500).json({
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message: isDevelopment ? err.message : "An unexpected error occurred",
      ...(isDevelopment && { stack: err.stack }),
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// 404 Handler
// ─────────────────────────────────────────────────────────────────────────
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: {
      code: "NOT_FOUND",
      message: `Route ${req.method} ${req.url} not found`,
    },
  });
}