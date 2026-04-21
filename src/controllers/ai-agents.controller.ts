import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import {
  listThreads,
  getThread,
  createThread,
  archiveThread,
  sendMessage,
  generateContent,
  extractMeetingNotes,
  type AgentKind,
} from "../services/ai-agent.service";

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

const agentKindSchema = z.enum(["sales", "content", "meeting"]);

// ──────────────────────────────────────────────────────────────────────
// THREADS
// ──────────────────────────────────────────────────────────────────────

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, companyId } = auth(req);
    const kind = agentKindSchema.parse(req.query.kind ?? "sales");
    const data = await listThreads(companyId, userId, kind);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function detail(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const data = await getThread(
      companyId,
      userId,
      req.params.id as string
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

const createThreadSchema = z.object({
  agentKind: agentKindSchema,
  relatedActivityId: z.string().uuid().optional(),
});

export async function create(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const dto = createThreadSchema.parse(req.body);
    const data = await createThread(
      companyId,
      userId,
      dto.agentKind,
      dto.relatedActivityId ? { relatedActivityId: dto.relatedActivityId } : undefined
    );
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function archive(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const data = await archiveThread(
      companyId,
      userId,
      req.params.id as string
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// SEND MESSAGE (sales assistant)
// ──────────────────────────────────────────────────────────────────────

const sendMessageSchema = z.object({
  message: z.string().min(1).max(10000),
});

export async function send(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, companyId } = auth(req);
    const { message } = sendMessageSchema.parse(req.body);
    const data = await sendMessage(
      companyId,
      userId,
      req.params.id as string,
      message
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// CONTENT WRITER
// ──────────────────────────────────────────────────────────────────────

const contentSchema = z.object({
  kind: z.enum(["email", "whatsapp", "social"]),
  prompt: z.string().min(1).max(5000),
  tone: z.string().max(100).optional(),
  language: z.enum(["ar", "en", "tr"]).optional(),
  context: z.record(z.string()).optional(),
});

export async function generateContentHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const dto = contentSchema.parse(req.body);
    const data = await generateContent(dto as any);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// MEETING NOTES
// ──────────────────────────────────────────────────────────────────────

const meetingSchema = z.object({
  transcript: z.string().min(20).max(100000),
  language: z.enum(["ar", "en", "tr"]).optional(),
});

export async function meetingNotesHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const dto = meetingSchema.parse(req.body);
    const data = await extractMeetingNotes(dto as any);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
