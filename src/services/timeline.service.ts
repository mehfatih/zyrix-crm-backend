import { prisma } from "../config/database";

// ============================================================================
// ACTIVITY TIMELINE SERVICE
// Unified chronological timeline for a customer from multiple sources
// ============================================================================

export type TimelineEventType =
  | "activity"
  | "deal_created"
  | "deal_stage_change"
  | "task_created"
  | "task_completed"
  | "quote_issued"
  | "quote_accepted"
  | "quote_rejected"
  | "contract_signed"
  | "email_campaign"
  | "whatsapp_message"
  | "loyalty_earned"
  | "loyalty_redeemed"
  | "note"
  | "call"
  | "meeting";

export interface TimelineEvent {
  id: string;
  type: TimelineEventType;
  timestamp: string;
  title: string;
  description?: string | null;
  icon: string;
  color: string;
  userName?: string | null;
  metadata?: Record<string, any>;
}

const ICONS: Record<string, { icon: string; color: string }> = {
  activity: { icon: "activity", color: "cyan" },
  call: { icon: "phone", color: "blue" },
  email: { icon: "mail", color: "indigo" },
  meeting: { icon: "calendar", color: "violet" },
  note: { icon: "file-text", color: "slate" },
  deal_created: { icon: "briefcase", color: "emerald" },
  deal_stage_change: { icon: "trending-up", color: "teal" },
  task_created: { icon: "check-square", color: "sky" },
  task_completed: { icon: "check-circle", color: "emerald" },
  quote_issued: { icon: "file-text", color: "indigo" },
  quote_accepted: { icon: "check-circle-2", color: "emerald" },
  quote_rejected: { icon: "x-circle", color: "rose" },
  contract_signed: { icon: "file-signature", color: "amber" },
  email_campaign: { icon: "send", color: "pink" },
  whatsapp_message: { icon: "message-circle", color: "green" },
  loyalty_earned: { icon: "award", color: "amber" },
  loyalty_redeemed: { icon: "gift", color: "rose" },
};

export interface TimelineFilters {
  types?: TimelineEventType[];
  since?: Date;
  until?: Date;
  limit?: number;
}

export async function getCustomerTimeline(
  companyId: string,
  customerId: string,
  filters: TimelineFilters = {}
): Promise<TimelineEvent[]> {
  const limit = Math.min(200, filters.limit ?? 100);
  const events: TimelineEvent[] = [];

  // 1. Activities (calls, meetings, notes)
  const activities = await prisma.activity.findMany({
    where: {
      companyId,
      customerId,
      ...(filters.since ? { createdAt: { gte: filters.since } } : {}),
      ...(filters.until ? { createdAt: { lte: filters.until } } : {}),
    },
    include: { user: { select: { fullName: true } } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  for (const a of activities) {
    const typeKey =
      a.type === "call" || a.type === "meeting" || a.type === "email"
        ? a.type
        : "activity";
    events.push({
      id: `activity:${a.id}`,
      type: typeKey as TimelineEventType,
      timestamp: a.createdAt.toISOString(),
      title: a.subject || typeKey,
      description: a.description || null,
      icon: ICONS[typeKey]?.icon || "activity",
      color: ICONS[typeKey]?.color || "cyan",
      userName: a.user?.fullName || null,
      metadata: { activityType: a.type },
    });
  }

  // 2. Deals
  const deals = await prisma.deal.findMany({
    where: {
      companyId,
      customerId,
      ...(filters.since ? { createdAt: { gte: filters.since } } : {}),
      ...(filters.until ? { createdAt: { lte: filters.until } } : {}),
    },
    include: { owner: { select: { fullName: true } } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  for (const d of deals) {
    events.push({
      id: `deal:${d.id}:created`,
      type: "deal_created",
      timestamp: d.createdAt.toISOString(),
      title: `Deal created: ${d.title}`,
      description: `${d.currency} ${Number(d.value).toFixed(2)} · ${d.stage}`,
      icon: ICONS.deal_created.icon,
      color: ICONS.deal_created.color,
      userName: d.owner?.fullName || null,
      metadata: { dealId: d.id, value: d.value, stage: d.stage },
    });
    // Closed events
    if (d.actualCloseDate) {
      const isWon = d.stage === "won";
      events.push({
        id: `deal:${d.id}:closed`,
        type: "deal_stage_change",
        timestamp: d.actualCloseDate.toISOString(),
        title: `Deal ${isWon ? "won" : "lost"}: ${d.title}`,
        description: isWon
          ? `${d.currency} ${Number(d.value).toFixed(2)}`
          : d.lostReason || null,
        icon: isWon ? "check-circle-2" : "x-circle",
        color: isWon ? "emerald" : "rose",
        userName: d.owner?.fullName || null,
        metadata: { dealId: d.id, stage: d.stage },
      });
    }
  }

  // 3. Tasks
  const tasks = await prisma.task.findMany({
    where: {
      companyId,
      customerId,
      ...(filters.since ? { createdAt: { gte: filters.since } } : {}),
    },
    include: { assignedTo: { select: { fullName: true } } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  for (const t of tasks) {
    events.push({
      id: `task:${t.id}:created`,
      type: "task_created",
      timestamp: t.createdAt.toISOString(),
      title: `Task: ${t.title}`,
      description: t.description || null,
      icon: ICONS.task_created.icon,
      color: ICONS.task_created.color,
      userName: t.assignedTo?.fullName || null,
      metadata: { taskId: t.id, priority: t.priority },
    });
    if (t.status === "done") {
      events.push({
        id: `task:${t.id}:completed`,
        type: "task_completed",
        timestamp: t.updatedAt.toISOString(),
        title: `Task completed: ${t.title}`,
        icon: ICONS.task_completed.icon,
        color: ICONS.task_completed.color,
        userName: t.assignedTo?.fullName || null,
      });
    }
  }

  // 4. Quotes
  const quotes = await prisma.quote.findMany({
    where: { companyId, customerId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  for (const q of quotes) {
    if (q.issuedAt) {
      events.push({
        id: `quote:${q.id}:issued`,
        type: "quote_issued",
        timestamp: q.issuedAt.toISOString(),
        title: `Quote issued: ${q.quoteNumber}`,
        description: `${q.title} — ${q.currency} ${Number(q.total).toFixed(2)}`,
        icon: ICONS.quote_issued.icon,
        color: ICONS.quote_issued.color,
        metadata: { quoteId: q.id, total: q.total },
      });
    }
    if (q.acceptedAt) {
      events.push({
        id: `quote:${q.id}:accepted`,
        type: "quote_accepted",
        timestamp: q.acceptedAt.toISOString(),
        title: `Quote accepted: ${q.quoteNumber}`,
        icon: ICONS.quote_accepted.icon,
        color: ICONS.quote_accepted.color,
        metadata: { quoteId: q.id },
      });
    }
    if (q.rejectedAt) {
      events.push({
        id: `quote:${q.id}:rejected`,
        type: "quote_rejected",
        timestamp: q.rejectedAt.toISOString(),
        title: `Quote rejected: ${q.quoteNumber}`,
        icon: ICONS.quote_rejected.icon,
        color: ICONS.quote_rejected.color,
        metadata: { quoteId: q.id },
      });
    }
  }

  // 5. Contracts
  const contracts = await prisma.contract.findMany({
    where: { companyId, customerId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  for (const c of contracts) {
    if (c.signedAt) {
      events.push({
        id: `contract:${c.id}:signed`,
        type: "contract_signed",
        timestamp: c.signedAt.toISOString(),
        title: `Contract signed: ${c.contractNumber}`,
        description: `${c.title} — ${c.currency} ${Number(c.value).toFixed(2)}`,
        icon: ICONS.contract_signed.icon,
        color: ICONS.contract_signed.color,
        metadata: { contractId: c.id, value: c.value },
      });
    }
  }

  // 6. WhatsApp messages
  const waMessages = await prisma.whatsappChat.findMany({
    where: {
      companyId,
      customerId,
      ...(filters.since ? { timestamp: { gte: filters.since } } : {}),
    },
    orderBy: { timestamp: "desc" },
    take: 50,
  });
  for (const m of waMessages) {
    events.push({
      id: `whatsapp:${m.id}`,
      type: "whatsapp_message",
      timestamp: m.timestamp.toISOString(),
      title: `WhatsApp ${m.direction === "incoming" ? "received" : "sent"}`,
      description:
        m.messageText.length > 120
          ? m.messageText.slice(0, 120) + "..."
          : m.messageText,
      icon: ICONS.whatsapp_message.icon,
      color: ICONS.whatsapp_message.color,
      metadata: { direction: m.direction },
    });
  }

  // 7. Loyalty transactions
  const loyalty = await prisma.loyaltyTransaction.findMany({
    where: {
      companyId,
      customerId,
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  for (const l of loyalty) {
    const isEarn = l.type === "earn";
    events.push({
      id: `loyalty:${l.id}`,
      type: isEarn ? "loyalty_earned" : "loyalty_redeemed",
      timestamp: l.createdAt.toISOString(),
      title: isEarn
        ? `Earned ${l.points} loyalty points`
        : `Redeemed ${Math.abs(l.points)} loyalty points`,
      description: l.description || null,
      icon: isEarn ? ICONS.loyalty_earned.icon : ICONS.loyalty_redeemed.icon,
      color: isEarn ? ICONS.loyalty_earned.color : ICONS.loyalty_redeemed.color,
      metadata: { points: l.points },
    });
  }

  // Sort all events by timestamp desc
  events.sort(
    (a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  // Apply type filter if provided
  const filtered = filters.types
    ? events.filter((e) => filters.types!.includes(e.type))
    : events;

  return filtered.slice(0, limit);
}
