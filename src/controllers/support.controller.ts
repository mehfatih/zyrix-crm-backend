import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types";
import { verifyAccessToken } from "../utils/jwt";
import { badRequest, notFound } from "../middleware/errorHandler";
import * as convo from "../services/support/conversation";
import * as ai from "../services/support/ai";
import { subscribe } from "../services/support/stream";
import { notifyEscalation } from "../services/support/notify";
import { sendTranscriptEmail } from "../services/support/email";
import { recordIntegrationEvent } from "../services/integration-events.service";

// ============================================================================
// SUPPORT WIDGET CONTROLLER (/api/support) — merchant (session auth)
// ============================================================================

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId, email: r.user.email };
}

const WELCOME: Record<string, string> = {
  en: "Hi — how can we help? We usually reply quickly, and we're sorry for any delay during busy periods.",
  ar: "مرحبًا — كيف يمكننا مساعدتك؟ نرد عادةً بسرعة، ونعتذر عن أي تأخير خلال أوقات الذروة.",
  tr: "Merhaba — nasıl yardımcı olabiliriz? Genelde hızlı yanıt veririz, yoğun zamanlardaki gecikmeler için özür dileriz.",
};
const localeOf = (v: unknown): string => (v === "ar" || v === "tr" ? v : "en");

// POST /conversations — start a chat. Body: { email?, transcriptOptIn?, locale? }
export async function start(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, companyId, email } = auth(req);
    const contactEmail = typeof req.body?.email === "string" && req.body.email.trim() ? req.body.email.trim() : email;
    const transcriptOptIn = Boolean(req.body?.transcriptOptIn);
    const locale = localeOf(req.body?.locale);

    const { id } = await convo.createConversation({ companyId, userId, contactEmail, transcriptOptIn });
    await convo.appendMessage(id, "system", WELCOME[locale]);
    await recordIntegrationEvent({
      companyId,
      platform: "support",
      eventType: "support_chat_started",
      requestContext: { conversationId: id, transcriptOptIn },
    });
    res.status(200).json({
      success: true,
      data: { conversationId: id, aiAvailable: ai.isConfigured(), contactEmail, transcriptOptIn },
    });
  } catch (err) {
    next(err);
  }
}

// GET /conversations/:id/messages?since=ISO
export async function messages(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const id = String(req.params.id);
    const conv = await convo.getForCompany(companyId, id);
    if (!conv) throw notFound("Conversation");
    const since = typeof req.query.since === "string" ? req.query.since : undefined;
    const list = await convo.listMessages(id, since);
    res.status(200).json({ success: true, data: { conversation: { id: conv.id, status: conv.status }, messages: list } });
  } catch (err) {
    next(err);
  }
}

// POST /conversations/:id/messages — user sends; AI replies unless human-handled.
export async function send(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const id = String(req.params.id);
    const conv = await convo.getForCompany(companyId, id);
    if (!conv) throw notFound("Conversation");
    if (conv.status === "closed") throw badRequest("Conversation is closed");

    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) throw badRequest("Message text is required");

    await convo.appendMessage(id, "user", text);
    if (!conv.subject) await convo.setSubject(id, (await ai.deriveSubject(text)) ?? text);

    // Human-handled (or awaiting a human) → the AI stays silent.
    if (conv.status === "human" || conv.status === "awaiting_human") {
      return res.status(200).json({ success: true, data: { offerHandoff: false, route: null, aiReplied: false } });
    }

    // open_ai: if no AI key, route straight to a human; else generate a reply.
    if (!ai.isConfigured()) {
      await convo.escalate(id);
      await convo.appendMessage(id, "system", "Connecting you to our team…");
      await fireEscalation(conv.companyId, id, conv.contactEmail, conv.subject, text);
      return res.status(200).json({ success: true, data: { offerHandoff: true, route: null, aiReplied: false } });
    }

    try {
      const history = await convo.listMessages(id);
      const result = await ai.generateReply(
        history.map((m) => ({ sender: m.sender, body: m.body })),
        text,
        companyId
      );
      if (result.reply) await convo.appendMessage(id, "ai", result.reply);
      await recordIntegrationEvent({
        companyId,
        platform: "support",
        eventType: "support_ai_reply",
        requestContext: { conversationId: id, offerHandoff: result.offerHandoff },
      });
      res.status(200).json({ success: true, data: { offerHandoff: result.offerHandoff, route: result.route, aiReplied: Boolean(result.reply) } });
    } catch (e) {
      // AI failed → offer a human rather than dead-ending.
      await recordIntegrationEvent({
        companyId,
        platform: "support",
        eventType: "support_ai_failed",
        errorMessage: (e as Error).message,
        requestContext: { conversationId: id },
      });
      res.status(200).json({ success: true, data: { offerHandoff: true, route: null, aiReplied: false } });
    }
  } catch (err) {
    next(err);
  }
}

// POST /conversations/:id/escalate
export async function escalate(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const id = String(req.params.id);
    const conv = await convo.getForCompany(companyId, id);
    if (!conv) throw notFound("Conversation");
    if (conv.status === "closed") throw badRequest("Conversation is closed");

    await convo.escalate(id);
    await convo.appendMessage(id, "system", "Connecting you to our team…");
    const last = (await convo.listMessages(id)).filter((m) => m.sender === "user").pop();
    await fireEscalation(conv.companyId, id, conv.contactEmail, conv.subject, last?.body ?? null);
    res.status(200).json({ success: true, data: { status: "awaiting_human" } });
  } catch (err) {
    next(err);
  }
}

// POST /conversations/:id/close — body { locale? }
export async function close(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const id = String(req.params.id);
    const conv = await convo.getForCompany(companyId, id);
    if (!conv) throw notFound("Conversation");

    await convo.closeConversation(id);

    // Emailed transcript (best-effort; no-op if mailer/opt-in absent).
    if (conv.transcriptOptIn && conv.contactEmail) {
      const all = await convo.listMessages(id);
      void sendTranscriptEmail({
        to: conv.contactEmail,
        locale: localeOf(req.body?.locale),
        messages: all.map((m) => ({ sender: m.sender, body: m.body, createdAt: m.createdAt })),
      });
    }
    res.status(200).json({ success: true, data: { status: "closed", surveyAvailable: true } });
  } catch (err) {
    next(err);
  }
}

// POST /conversations/:id/survey — body { qQuality?, qService?, qResolvedFast? } (1–5)
export async function survey(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const id = String(req.params.id);
    const conv = await convo.getForCompany(companyId, id);
    if (!conv) throw notFound("Conversation");
    await convo.saveSurvey(id, {
      qQuality: req.body?.qQuality,
      qService: req.body?.qService,
      qResolvedFast: req.body?.qResolvedFast,
    });
    res.status(200).json({ success: true, data: { saved: true } });
  } catch (err) {
    next(err);
  }
}

// GET /conversations/:id/stream — SSE. Auth via ?token= (EventSource can't set
// headers). Verifies the merchant token + tenant ownership before streaming.
export async function stream(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);
  const token = typeof req.query.token === "string" ? req.query.token : "";
  let companyId: string;
  try {
    const decoded = verifyAccessToken(token);
    companyId = decoded.companyId;
  } catch {
    res.status(401).end();
    return;
  }
  const conv = await convo.getForCompany(companyId, id);
  if (!conv) {
    res.status(404).end();
    return;
  }
  openSse(req, res, id);
}

// ── shared helpers ─────────────────────────────────────────────────────
async function fireEscalation(
  companyId: string,
  conversationId: string,
  contactEmail: string | null,
  subject: string | null,
  lastUserMessage: string | null
) {
  await recordIntegrationEvent({
    companyId,
    platform: "support",
    eventType: "support_escalated",
    requestContext: { conversationId },
  });
  void notifyEscalation({ conversationId, companyId, contactEmail, subject, lastUserMessage });
}

/** Open an SSE connection subscribed to a conversation. Shared by merchant + admin. */
export function openSse(req: Request, res: Response, conversationId: string): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`event: ready\ndata: {"ok":true}\n\n`);
  const unsubscribe = subscribe(conversationId, { write: (c) => res.write(c) });
  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch {
      /* ignore */
    }
  }, 25000);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}
