// ============================================================================
// SUPPORT — CONVERSATION SERVICE (state machine + persistence + fan-out)
// ----------------------------------------------------------------------------
// State: open_ai → awaiting_human → human → closed. Reuses the generated
// Prisma client (support_* models). Every appended message is published to SSE
// subscribers (stream.ts) for real-time delivery to the widget + admin console.
// ============================================================================

import { prisma } from "../../config/database";
import { publish } from "./stream";

export type SupportStatus = "open_ai" | "awaiting_human" | "human" | "closed";
export type SupportSender = "user" | "ai" | "human" | "system";

export interface SupportMessageRow {
  id: string;
  conversationId: string;
  sender: string;
  body: string;
  createdAt: Date;
}

export async function createConversation(params: {
  companyId: string;
  userId?: string | null;
  contactEmail?: string | null;
  transcriptOptIn?: boolean;
}): Promise<{ id: string }> {
  const conv = await prisma.supportConversation.create({
    data: {
      companyId: params.companyId,
      userId: params.userId ?? null,
      contactEmail: params.contactEmail ?? null,
      transcriptOptIn: Boolean(params.transcriptOptIn),
      status: "open_ai",
      lastMessageAt: new Date(),
    },
    select: { id: true },
  });
  return conv;
}

/** Tenant-scoped fetch for the merchant widget (companyId required). */
export async function getForCompany(companyId: string, id: string) {
  return prisma.supportConversation.findFirst({ where: { id, companyId } });
}

/** Unscoped fetch for the super-admin console. */
export async function getById(id: string) {
  return prisma.supportConversation.findUnique({ where: { id } });
}

export async function appendMessage(
  conversationId: string,
  sender: SupportSender,
  body: string
): Promise<SupportMessageRow> {
  const msg = await prisma.supportMessage.create({
    data: { conversationId, sender, body },
  });
  await prisma.supportConversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: msg.createdAt },
  });
  publish(conversationId, "message", {
    id: msg.id,
    conversationId,
    sender: msg.sender,
    body: msg.body,
    createdAt: msg.createdAt.toISOString(),
  });
  return msg;
}

export async function listMessages(
  conversationId: string,
  sinceIso?: string
): Promise<SupportMessageRow[]> {
  return prisma.supportMessage.findMany({
    where: {
      conversationId,
      ...(sinceIso ? { createdAt: { gt: new Date(sinceIso) } } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: 500,
  });
}

export async function setStatus(conversationId: string, status: SupportStatus): Promise<void> {
  await prisma.supportConversation.update({
    where: { id: conversationId },
    data: { status },
  });
  publish(conversationId, "status", { status });
}

export async function escalate(conversationId: string): Promise<void> {
  await prisma.supportConversation.update({
    where: { id: conversationId },
    data: { status: "awaiting_human", escalatedAt: new Date() },
  });
  publish(conversationId, "status", { status: "awaiting_human" });
}

export async function claim(conversationId: string, adminId: string): Promise<void> {
  await prisma.supportConversation.update({
    where: { id: conversationId },
    data: { status: "human", assignedAdminId: adminId },
  });
  publish(conversationId, "status", { status: "human" });
}

export async function closeConversation(conversationId: string): Promise<void> {
  await prisma.supportConversation.update({
    where: { id: conversationId },
    data: { status: "closed", closedAt: new Date() },
  });
  publish(conversationId, "status", { status: "closed" });
}

export async function markFallbackSent(conversationId: string): Promise<void> {
  await prisma.supportConversation.update({
    where: { id: conversationId },
    data: { fallbackSentAt: new Date() },
  });
}

export async function setSubject(conversationId: string, subject: string): Promise<void> {
  await prisma.supportConversation.update({
    where: { id: conversationId },
    data: { subject: subject.slice(0, 200) },
  });
}

// ── Survey (tap-only 1–5 × 3) ──────────────────────────────────────────
export async function saveSurvey(
  conversationId: string,
  answers: { qQuality?: number | null; qService?: number | null; qResolvedFast?: number | null }
): Promise<void> {
  const clamp = (n?: number | null) =>
    typeof n === "number" && n >= 1 && n <= 5 ? Math.round(n) : null;
  const data = {
    qQuality: clamp(answers.qQuality),
    qService: clamp(answers.qService),
    qResolvedFast: clamp(answers.qResolvedFast),
  };
  await prisma.supportSurvey.upsert({
    where: { conversationId },
    create: { conversationId, ...data },
    update: data,
  });
}

export async function getSurvey(conversationId: string) {
  return prisma.supportSurvey.findUnique({ where: { conversationId } });
}

// ── Admin console queue ────────────────────────────────────────────────
export async function listQueue(
  status: SupportStatus | "all",
  limit = 50
): Promise<Array<{ id: string; companyId: string; status: string; subject: string | null; contactEmail: string | null; assignedAdminId: string | null; lastMessageAt: Date | null; createdAt: Date }>> {
  return prisma.supportConversation.findMany({
    where: status === "all" ? {} : { status },
    orderBy: { lastMessageAt: "desc" },
    take: Math.min(Math.max(limit, 1), 200),
    select: {
      id: true,
      companyId: true,
      status: true,
      subject: true,
      contactEmail: true,
      assignedAdminId: true,
      lastMessageAt: true,
      createdAt: true,
    },
  });
}

/** Conversations escalated > N minutes ago with no human + no fallback yet. */
export async function findStaleEscalations(minutes: number) {
  const cutoff = new Date(Date.now() - minutes * 60 * 1000);
  return prisma.supportConversation.findMany({
    where: {
      status: "awaiting_human",
      escalatedAt: { lte: cutoff },
      fallbackSentAt: null,
    },
    take: 100,
  });
}
