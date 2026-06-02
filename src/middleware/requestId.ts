import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

// ============================================================================
// REQUEST ID MIDDLEWARE
// ----------------------------------------------------------------------------
// Assigns a uuid to every request (honoring an inbound X-Request-Id if a
// trusted proxy already set one) and echoes it back in the X-Request-Id
// response header. The error handler includes req.id in every error body so
// a customer-facing error and a Railway log line can be correlated.
// ============================================================================

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id?: string;
    }
  }
}

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.headers["x-request-id"];
  const id =
    typeof inbound === "string" && inbound.length > 0 && inbound.length <= 200
      ? inbound
      : randomUUID();
  req.id = id;
  res.setHeader("X-Request-Id", id);
  next();
}
