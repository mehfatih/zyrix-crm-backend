import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import {
  recordSessionEvent,
  getSessionKpis,
  type SessionEventType,
} from "../services/session-events.service";

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId, role: r.user.role };
}

// ============================================================================
// POST /api/session-events — record a single event
// ============================================================================
const recordSchema = z.object({
  eventType: z.enum([
    "login",
    "manual_logout",
    "auto_logout_idle",
    "session_expired",
  ]),
  metadata: z.record(z.unknown()).optional(),
});

export async function record(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, companyId } = auth(req);
    const dto = recordSchema.parse(req.body);
    await recordSessionEvent({
      userId,
      companyId,
      eventType: dto.eventType as SessionEventType,
      metadata: dto.metadata,
    });
    // 204 would be ideal but the frontend's generic axios client
    // expects a JSON envelope.
    res.status(201).json({ success: true });
  } catch (err) {
    next(err);
  }
}

// ============================================================================
// GET /api/session-events/kpis?from=&to=
// ============================================================================
// Defaults to last 24 hours if from/to not specified. Range is open-closed:
// [from, to). Managers + owners + admins can view all; regular members
// can only see their own stats.
// ============================================================================
const kpiQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  userId: z.string().uuid().optional(),
});

export async function kpis(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId: callerId, role } = auth(req);
    const q = kpiQuerySchema.parse(req.query);

    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const fromDate = q.from ? new Date(q.from) : dayAgo;
    const toDate = q.to ? new Date(q.to) : now;

    const data = await getSessionKpis(companyId, fromDate, toDate);

    // Role-scope filtering: non-managers only see their own row
    if (role !== "owner" && role !== "admin" && role !== "manager") {
      data.perUser = data.perUser.filter((r) => r.userId === callerId);
      // Recompute totals for the filtered set
      data.totals = data.perUser.reduce(
        (acc, r) => {
          acc.totalCloses += r.totalCloses;
          acc.manualLogouts += r.manualLogouts;
          acc.autoLogouts += r.autoLogouts;
          acc.sessionExpired += r.sessionExpired;
          acc.logins += r.logins;
          return acc;
        },
        {
          totalCloses: 0,
          manualLogouts: 0,
          autoLogouts: 0,
          sessionExpired: 0,
          logins: 0,
          autoLogoutRatio: 0,
        }
      );
      data.totals.autoLogoutRatio =
        data.totals.totalCloses > 0
          ? data.totals.autoLogouts / data.totals.totalCloses
          : 0;
    }

    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
