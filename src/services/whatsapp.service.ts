import { prisma } from "../config/database";
import {
  extractCustomerDataFromMessage,
  type ExtractedCustomerData,
} from "./ai.service";
import type { Prisma } from "@prisma/client";

// ============================================================================
// WHATSAPP SERVICE
// ============================================================================
// Handles incoming WhatsApp messages, auto-extracts data, creates/updates
// customers, and logs activities.
// ============================================================================

export interface IncomingMessage {
  phoneNumber: string;
  messageText: string;
  messageId?: string;
  mediaUrl?: string;
  timestamp?: Date;
}

// ─────────────────────────────────────────────────────────────────────────
// Process incoming WhatsApp message
// ─────────────────────────────────────────────────────────────────────────
export async function processIncomingMessage(
  companyId: string,
  message: IncomingMessage
) {
  // 1. Check if customer exists by phone/whatsappPhone
  let customer = await prisma.customer.findFirst({
    where: {
      companyId,
      OR: [
        { phone: message.phoneNumber },
        { whatsappPhone: message.phoneNumber },
      ],
    },
  });

  // 2. Get previous messages for context (last 5)
  const previousMessages = customer
    ? await prisma.whatsappChat.findMany({
        where: { companyId, customerId: customer.id },
        orderBy: { timestamp: "desc" },
        take: 5,
        select: { messageText: true, direction: true },
      })
    : [];

  const contextArr = previousMessages
    .reverse()
    .map((m) => `[${m.direction}] ${m.messageText}`);

  // 3. Extract data via Gemini
  let extracted: ExtractedCustomerData = {};
  try {
    extracted = await extractCustomerDataFromMessage(
      message.messageText,
      contextArr
    );
  } catch (error) {
    console.error("[WhatsApp] AI extraction failed:", error);
  }

  // 4. Create customer if doesn't exist
  if (!customer) {
    customer = await prisma.customer.create({
      data: {
        companyId,
        fullName: extracted.fullName || `WhatsApp ${message.phoneNumber}`,
        email: extracted.email?.toLowerCase(),
        phone: message.phoneNumber,
        whatsappPhone: message.phoneNumber,
        companyName: extracted.companyName,
        position: extracted.position,
        country: extracted.location,
        source: "whatsapp",
        status: "new",
        aiExtracted: extracted as Prisma.InputJsonValue,
        lastContactAt: message.timestamp || new Date(),
      },
    });
  } else {
    // Update existing customer with new extracted data (only filling empty fields)
    const updates: Prisma.CustomerUpdateInput = {
      lastContactAt: message.timestamp || new Date(),
    };

    if (!customer.fullName.startsWith("WhatsApp ") && extracted.fullName) {
      // Keep name as is — don't override manual name
    } else if (customer.fullName.startsWith("WhatsApp ") && extracted.fullName) {
      updates.fullName = extracted.fullName;
    }

    if (!customer.email && extracted.email) {
      updates.email = extracted.email.toLowerCase();
    }
    if (!customer.companyName && extracted.companyName) {
      updates.companyName = extracted.companyName;
    }
    if (!customer.position && extracted.position) {
      updates.position = extracted.position;
    }
    if (!customer.country && extracted.location) {
      updates.country = extracted.location;
    }

    // Merge AI data
    updates.aiExtracted = {
      ...((customer.aiExtracted as object) || {}),
      latest: extracted,
      lastUpdated: new Date().toISOString(),
    } as Prisma.InputJsonValue;

    customer = await prisma.customer.update({
      where: { id: customer.id },
      data: updates,
    });
  }

  // 5. Store the chat message
  const chat = await prisma.whatsappChat.create({
    data: {
      companyId,
      customerId: customer.id,
      phoneNumber: message.phoneNumber,
      messageText: message.messageText,
      direction: "inbound",
      messageId: message.messageId,
      mediaUrl: message.mediaUrl,
      aiProcessed: true,
      aiExtracted: extracted as Prisma.InputJsonValue,
      timestamp: message.timestamp || new Date(),
    },
  });

  // 6. Log an activity
  await prisma.activity.create({
    data: {
      companyId,
      userId: customer.ownerId || (await getFirstOwnerId(companyId)),
      customerId: customer.id,
      type: "whatsapp",
      title: extracted.summary || `WhatsApp from ${customer.fullName}`,
      content: message.messageText,
      metadata: {
        phoneNumber: message.phoneNumber,
        extracted: extracted as Prisma.JsonObject,
      } as Prisma.InputJsonValue,
    },
  });

  return { customer, chat, extracted };
}

// ─────────────────────────────────────────────────────────────────────────
// Store outgoing message
// ─────────────────────────────────────────────────────────────────────────
export async function logOutgoingMessage(
  companyId: string,
  customerId: string,
  phoneNumber: string,
  messageText: string
) {
  return prisma.whatsappChat.create({
    data: {
      companyId,
      customerId,
      phoneNumber,
      messageText,
      direction: "outbound",
      aiProcessed: false,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Get chat history for a customer
// ─────────────────────────────────────────────────────────────────────────
export async function getCustomerChatHistory(
  companyId: string,
  customerId: string,
  limit: number = 50
) {
  return prisma.whatsappChat.findMany({
    where: { companyId, customerId },
    orderBy: { timestamp: "desc" },
    take: limit,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Helper: get the owner user of the company (fallback for auto-assignment)
// ─────────────────────────────────────────────────────────────────────────
async function getFirstOwnerId(companyId: string): Promise<string> {
  const owner = await prisma.user.findFirst({
    where: { companyId, role: "owner" },
    select: { id: true },
  });
  if (!owner) {
    throw new Error(`No owner found for company ${companyId}`);
  }
  return owner.id;
}