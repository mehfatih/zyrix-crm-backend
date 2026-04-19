import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as whatsappService from "../services/whatsapp.service";
import {
  generateReplySuggestion,
  summarizeConversation,
} from "../services/ai.service";
import { prisma } from "../config/database";
import type { AuthenticatedRequest } from "../types";
import { badRequest } from "../middleware/errorHandler";

const incomingMessageSchema = z.object({
  phoneNumber: z.string().min(5),
  messageText: z.string().min(1).max(5000),
  messageId: z.string().optional(),
  mediaUrl: z.string().url().optional(),
  timestamp: z.string().datetime().optional(),
});

const outgoingMessageSchema = z.object({
  customerId: z.string().uuid(),
  messageText: z.string().min(1).max(5000),
});

const suggestReplySchema = z.object({
  messageText: z.string().min(1).max(5000),
  customerName: z.string().optional(),
  language: z.enum(["ar", "en", "tr"]).optional().default("en"),
});

function getParamId(req: Request, key: string = "customerId"): string {
  const value = req.params[key];
  if (!value) throw badRequest(`Missing parameter: ${key}`);
  return Array.isArray(value) ? value[0] : value;
}

export async function receiveIncoming(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const dto = incomingMessageSchema.parse(req.body);

    const result = await whatsappService.processIncomingMessage(
      authReq.user.companyId,
      {
        phoneNumber: dto.phoneNumber,
        messageText: dto.messageText,
        messageId: dto.messageId,
        mediaUrl: dto.mediaUrl,
        timestamp: dto.timestamp ? new Date(dto.timestamp) : new Date(),
      }
    );

    res.status(201).json({
      success: true,
      data: result,
      message: "Message processed with AI extraction",
    });
  } catch (error) {
    next(error);
  }
}

export async function sendOutgoing(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const dto = outgoingMessageSchema.parse(req.body);

    const customer = await prisma.customer.findFirst({
      where: { id: dto.customerId, companyId: authReq.user.companyId },
    });

    if (!customer) throw badRequest("Customer not found");
    const phone = customer.whatsappPhone || customer.phone;
    if (!phone) throw badRequest("Customer has no phone number");

    const chat = await whatsappService.logOutgoingMessage(
      authReq.user.companyId,
      dto.customerId,
      phone,
      dto.messageText
    );

    res.status(201).json({ success: true, data: chat });
  } catch (error) {
    next(error);
  }
}

export async function getChatHistory(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const customerId = getParamId(req);
    const limit = Number(req.query.limit) || 50;

    const chats = await whatsappService.getCustomerChatHistory(
      authReq.user.companyId,
      customerId,
      limit
    );

    res.json({ success: true, data: chats });
  } catch (error) {
    next(error);
  }
}

export async function aiSuggestReply(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const dto = suggestReplySchema.parse(req.body);
    const reply = await generateReplySuggestion(
      dto.messageText,
      dto.customerName,
      dto.language
    );
    res.json({ success: true, data: { reply } });
  } catch (error) {
    next(error);
  }
}

export async function aiSummarize(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const customerId = getParamId(req);

    const chats = await whatsappService.getCustomerChatHistory(
      authReq.user.companyId,
      customerId,
      20
    );

    const messages = chats
      .reverse()
      .map((c) => `[${c.direction}] ${c.messageText}`);

    const summary = await summarizeConversation(messages);
    res.json({ success: true, data: { summary, messageCount: chats.length } });
  } catch (error) {
    next(error);
  }
}