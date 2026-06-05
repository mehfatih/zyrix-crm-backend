// ============================================================================
// QUOTE EVENTS — Sprint 9
// ----------------------------------------------------------------------------
// Append-only tracking log for a quote's lifecycle (sent / viewed / accepted /
// rejected / approval_requested / approved). Powers the quote timeline and the
// list badges. Writes are best-effort and never block the main flow.
// ============================================================================

import { prisma } from "../config/database";

export type QuoteEventType =
  | "sent"
  | "viewed"
  | "accepted"
  | "rejected"
  | "approval_requested"
  | "approved"
  | "approval_rejected";

export async function recordQuoteEvent(
  companyId: string,
  quoteId: string,
  type: QuoteEventType,
  meta?: Record<string, unknown>
): Promise<void> {
  try {
    await prisma.quoteEvent.create({
      data: {
        companyId,
        quoteId,
        type,
        meta: meta ? JSON.stringify(meta) : null,
      },
    });
  } catch (err) {
    console.error("[quote-events] write failed (non-fatal):", err);
  }
}

export async function listQuoteEvents(companyId: string, quoteId: string) {
  const rows = await prisma.quoteEvent.findMany({
    where: { companyId, quoteId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({
    ...r,
    meta: r.meta ? safeParse(r.meta) : null,
  }));
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
