import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { isDevelopment } from "../config/env";
import { recordIntegrationEvent } from "../services/integration-events.service";

// ============================================================================
// GLOBAL ERROR HANDLER
// ============================================================================
// Catches all errors thrown in async routes and returns consistent JSON.
// ============================================================================

// Optional typed metadata carried by integration-layer errors. Backward
// compatible — existing `new AppError(msg, status, code, details)` calls keep
// working; these fields default to undefined.
export interface AppErrorMeta {
  // Coarse bucket for dashboards/logs: 'oauth' | 'sync' | 'token' | 'config' | 'validation' | 'upstream'
  category?: string;
  // i18n key the frontend maps to a localized, actionable message.
  userMessageKey?: string;
  // Structured context for logging (route, shop, userId, companyId, platform…).
  // NEVER put tokens/secrets/hmac here.
  context?: Record<string, unknown>;
}

export class AppError extends Error {
  public statusCode: number;
  public code: string;
  public details?: unknown;
  public category?: string;
  public userMessageKey?: string;
  public context?: Record<string, unknown>;

  constructor(
    message: string,
    statusCode: number = 500,
    code: string = "INTERNAL_ERROR",
    details?: unknown,
    meta?: AppErrorMeta
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.category = meta?.category;
    this.userMessageKey = meta?.userMessageKey;
    this.context = meta?.context;
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
  // Per-request id for traceability (set by requestId middleware; falls back
  // to "-" if the middleware wasn't mounted on this path).
  const requestId = (req as { id?: string }).id ?? "-";

  // Log every error to stderr — captured by Railway runtime logs in prod.
  // The response body separately redacts message + stack in non-dev
  // (see the unknown-error branch at the end of this function), so the
  // stack goes to logs but never to the client.
  console.error("[ERROR]", {
    requestId,
    url: req.url,
    method: req.method,
    code: err instanceof AppError ? err.code : undefined,
    category: err instanceof AppError ? err.category : undefined,
    error: err.message,
    stack: err.stack,
  });

  // Zod validation errors
  if (err instanceof ZodError) {
    res.status(422).json({
      success: false,
      requestId,
      error: {
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        requestId,
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
    // Integration-layer failures get one structured row in integration_events
    // so the Health Dashboard reflects real numbers. Fire-and-forget; the
    // service swallows its own errors. Never logs tokens/secrets.
    if (err.context && (err.context.platform || err.category === "oauth" || err.category === "sync" || err.category === "token")) {
      void recordIntegrationEvent({
        companyId: (err.context.companyId as string) ?? null,
        platform: (err.context.platform as string) ?? "shopify",
        eventType: err.category === "sync" ? "sync_failure" : err.category === "token" ? "token_refresh_failure" : "oauth_failure",
        errorCode: err.code,
        errorMessage: err.message,
        requestContext: { ...err.context, route: req.originalUrl, method: req.method, requestId },
      });
    }
    res.status(err.statusCode).json({
      success: false,
      requestId,
      error: {
        code: err.code,
        // userMessageKey lets the frontend show a localized, actionable
        // message; message is the developer-facing fallback.
        message: err.message,
        userMessageKey: err.userMessageKey,
        requestId,
        details: err.details,
      },
    });
    return;
  }

  // Prisma errors (common ones)
  if (err.message.includes("Unique constraint")) {
    res.status(409).json({
      success: false,
      requestId,
      error: {
        code: "DUPLICATE_ENTRY",
        message: "A record with this value already exists",
        requestId,
      },
    });
    return;
  }

  // Unknown errors
  res.status(500).json({
    success: false,
    requestId,
    error: {
      code: "INTERNAL_ERROR",
      message: isDevelopment ? err.message : "An unexpected error occurred",
      requestId,
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