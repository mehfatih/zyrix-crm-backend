// ============================================================================
// SESSION EVENTS SERVICE
// ----------------------------------------------------------------------------
// Records per-user session lifecycle events (login / manual_logout /
// auto_logout_idle / session_expired) + aggregates them into the KPIs
// the admin dashboard shows.
//
// Design notes:
//   • Writes are fire-and-forget from the frontend's perspective — if a
//     POST fails we don't block the actual logout because getting the
//     user out of the system is always higher priority than the metric
//   • Reads power two views:
//       1. Per-user breakdown: "Mehmet had 8 total closes today — 6
//          manual, 2 auto"
//       2. Company-wide: "Company had 47 auto-logouts in the past 7
//          days, 82 manual"
//   • Shift-aware: the frontend can pass a start/end range (e.g.
//     9 AM to 6 PM) to scope KPIs to the actual working hours, so
//     employees don't get penalized for auto-logouts after-hours
// ============================================================================

import { prisma } from "../config/database";

export type SessionEventType =
  | "login"
  | "manual_logout"
  | "auto_logout_idle"
  | "session_expired";

export interface RecordSessionEventInput {
  userId: string;
  companyId: string;
  eventType: SessionEventType;
  metadata?: Record<string, unknown>;
}

export async function recordSessionEvent(
  input: RecordSessionEventInput
): Promise<void> {
  // Use raw SQL so Prisma regen isn't required for deployment
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO session_events (id, "userId", "companyId", "eventType", metadata, "createdAt")
       VALUES (gen_random_uuid(), $1, $2, $3, $4::jsonb, NOW())`,
      input.userId,
      input.companyId,
      input.eventType,
      JSON.stringify(input.metadata ?? {})
    );
  } catch (err) {
    // Logging-only; never throw — we don't want to break logout flows
    // because telemetry failed.
    console.error("[session-events] failed to record", err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// KPI AGGREGATION
// ──────────────────────────────────────────────────────────────────────

export interface SessionKpiRow {
  userId: string;
  userName: string | null;
  userEmail: string | null;
  totalCloses: number; // manual_logout + auto_logout_idle + session_expired
  manualLogouts: number;
  autoLogouts: number;
  sessionExpired: number;
  logins: number;
}

export interface SessionKpiSummary {
  // Time range the numbers cover (echoed back so the UI can confirm)
  from: string;
  to: string;
  // Per-employee breakdown
  perUser: SessionKpiRow[];
  // Company-wide totals across the range
  totals: {
    totalCloses: number;
    manualLogouts: number;
    autoLogouts: number;
    sessionExpired: number;
    logins: number;
    /** 0..1 — fraction of closes that were auto. High values may
     *  signal employees leaving Zyrix open in a background tab. */
    autoLogoutRatio: number;
  };
}

export async function getSessionKpis(
  companyId: string,
  fromDate: Date,
  toDate: Date
): Promise<SessionKpiSummary> {
  // One grouped query pulls all the counts at once, then we sum in JS
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT
       se."userId",
       u."fullName",
       u.email,
       se."eventType",
       COUNT(*)::int AS cnt
     FROM session_events se
     JOIN users u ON u.id = se."userId"
     WHERE se."companyId" = $1
       AND se."createdAt" >= $2
       AND se."createdAt" < $3
     GROUP BY se."userId", u."fullName", u.email, se."eventType"`,
    companyId,
    fromDate,
    toDate
  )) as Array<{
    userId: string;
    fullName: string | null;
    email: string | null;
    eventType: string;
    cnt: number;
  }>;

  // Pivot per-user
  const perUserMap = new Map<string, SessionKpiRow>();
  for (const row of rows) {
    let entry = perUserMap.get(row.userId);
    if (!entry) {
      entry = {
        userId: row.userId,
        userName: row.fullName,
        userEmail: row.email,
        totalCloses: 0,
        manualLogouts: 0,
        autoLogouts: 0,
        sessionExpired: 0,
        logins: 0,
      };
      perUserMap.set(row.userId, entry);
    }
    switch (row.eventType) {
      case "login":
        entry.logins += row.cnt;
        break;
      case "manual_logout":
        entry.manualLogouts += row.cnt;
        entry.totalCloses += row.cnt;
        break;
      case "auto_logout_idle":
        entry.autoLogouts += row.cnt;
        entry.totalCloses += row.cnt;
        break;
      case "session_expired":
        entry.sessionExpired += row.cnt;
        entry.totalCloses += row.cnt;
        break;
    }
  }

  const perUser = Array.from(perUserMap.values()).sort(
    (a, b) => b.totalCloses - a.totalCloses
  );

  // Sum totals
  const totals = perUser.reduce(
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
  totals.autoLogoutRatio =
    totals.totalCloses > 0 ? totals.autoLogouts / totals.totalCloses : 0;

  return {
    from: fromDate.toISOString(),
    to: toDate.toISOString(),
    perUser,
    totals,
  };
}
