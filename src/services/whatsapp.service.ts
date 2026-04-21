import { prisma } from "../config/database";
import {
  extractCustomerDataFromMessage,
  type ExtractedCustomerData,
} from "./ai.service";
import type { Prisma } from "@prisma/client";

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
  // 1. Check if customer exists
  let customer = await prisma.customer.findFirst({
    where: {
      companyId,
      OR: [
        { phone: message.phoneNumber },
        { whatsappPhone: message.phoneNumber },
      ],
    },
  });

  // 2. Get previous messages for context
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
        aiExtracted: extracted as unknown as Prisma.InputJsonValue,
        lastContactAt: message.timestamp || new Date(),
      },
    });
  } else {
    // Update existing customer
    const updates: Prisma.CustomerUpdateInput = {
      lastContactAt: message.timestamp || new Date(),
    };

    if (customer.fullName.startsWith("WhatsApp ") && extracted.fullName) {
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
    const mergedAiData = {
      ...((customer.aiExtracted as object) || {}),
      latest: extracted,
      lastUpdated: new Date().toISOString(),
    };
    updates.aiExtracted = mergedAiData as unknown as Prisma.InputJsonValue;

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
      aiExtracted: extracted as unknown as Prisma.InputJsonValue,
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
        extracted: extracted,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  return { customer, chat, extracted };
}

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
// ============================================================================
// META CLOUD API INTEGRATION
// ============================================================================

export interface MetaWebhookMessage {
  from: string;
  id: string;
  timestamp: string;
  text?: { body: string };
  image?: { id: string; mime_type: string; caption?: string };
  type: string;
}

// ─────────────────────────────────────────────────────────────────────────
// INBOX — grouped list of active conversations (one per phone number)
// ─────────────────────────────────────────────────────────────────────────
export async function getInbox(companyId: string) {
  // All distinct phone numbers with most-recent message info
  const allChats = await prisma.whatsappChat.findMany({
    where: { companyId },
    orderBy: { timestamp: "desc" },
    take: 500,
    select: {
      phoneNumber: true,
      messageText: true,
      direction: true,
      timestamp: true,
      customerId: true,
    },
  });

  const byPhone = new Map<
    string,
    {
      phoneNumber: string;
      lastMessage: string;
      lastDirection: string;
      lastTimestamp: Date;
      customerId: string | null;
      messageCount: number;
    }
  >();

  for (const c of allChats) {
    if (!byPhone.has(c.phoneNumber)) {
      byPhone.set(c.phoneNumber, {
        phoneNumber: c.phoneNumber,
        lastMessage: c.messageText,
        lastDirection: c.direction,
        lastTimestamp: c.timestamp,
        customerId: c.customerId,
        messageCount: 1,
      });
    } else {
      byPhone.get(c.phoneNumber)!.messageCount++;
    }
  }

  const phones = Array.from(byPhone.keys());
  const customerIds = Array.from(byPhone.values())
    .map((v) => v.customerId)
    .filter((v): v is string => !!v);

  const customers = customerIds.length
    ? await prisma.customer.findMany({
        where: { id: { in: customerIds }, companyId },
        select: {
          id: true,
          fullName: true,
          companyName: true,
          email: true,
          status: true,
        },
      })
    : [];
  const customerMap = new Map(customers.map((c) => [c.id, c]));

  return Array.from(byPhone.values())
    .map((v) => ({
      ...v,
      lastTimestamp: v.lastTimestamp.toISOString(),
      customer: v.customerId ? customerMap.get(v.customerId) || null : null,
    }))
    .sort(
      (a, b) =>
        new Date(b.lastTimestamp).getTime() -
        new Date(a.lastTimestamp).getTime()
    );
}

// ─────────────────────────────────────────────────────────────────────────
// THREAD — messages for a specific phone number
// ─────────────────────────────────────────────────────────────────────────
export async function getThread(companyId: string, phoneNumber: string) {
  const messages = await prisma.whatsappChat.findMany({
    where: { companyId, phoneNumber },
    orderBy: { timestamp: "asc" },
    take: 500,
  });

  const customerId = messages.find((m) => m.customerId)?.customerId ?? null;
  let customer: any = null;
  if (customerId) {
    customer = await prisma.customer.findFirst({
      where: { id: customerId, companyId },
      select: {
        id: true,
        fullName: true,
        companyName: true,
        email: true,
        phone: true,
        whatsappPhone: true,
        status: true,
      },
    });
  }

  return { phoneNumber, customer, messages };
}

// ─────────────────────────────────────────────────────────────────────────
// META CLOUD API — send message (requires env vars WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID)
// ─────────────────────────────────────────────────────────────────────────
export async function sendViaMetaCloud(
  companyId: string,
  phoneNumber: string,
  text: string
): Promise<{ success: boolean; messageId: string | null; error?: string }> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneId) {
    // Stub mode — just log to DB
    const msg = await logOutgoingMessage(companyId, {
      phoneNumber,
      messageText: text,
      messageId: `stub-${Date.now()}`,
    });
    return {
      success: false,
      messageId: msg.messageId ?? null,
      error: "Meta Cloud not configured — message saved locally only",
    };
  }

  try {
    const resp = await fetch(
      `https://graph.facebook.com/v20.0/${phoneId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: phoneNumber,
          type: "text",
          text: { body: text },
        }),
      }
    );
    const data: any = await resp.json();

    if (!resp.ok) {
      return {
        success: false,
        messageId: null,
        error: data?.error?.message || "Meta API error",
      };
    }

    const metaId = data?.messages?.[0]?.id ?? null;
    await logOutgoingMessage(companyId, {
      phoneNumber,
      messageText: text,
      messageId: metaId ?? undefined,
    });
    return { success: true, messageId: metaId };
  } catch (e: any) {
    return {
      success: false,
      messageId: null,
      error: e?.message || "Network error",
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// META CLOUD WEBHOOK — process incoming from Meta
// ─────────────────────────────────────────────────────────────────────────
export async function handleMetaWebhook(
  companyId: string,
  webhookBody: any
): Promise<{ processed: number }> {
  let processed = 0;

  try {
    const entries = webhookBody?.entry ?? [];
    for (const entry of entries) {
      const changes = entry?.changes ?? [];
      for (const change of changes) {
        const value = change?.value;
        const messages: MetaWebhookMessage[] = value?.messages ?? [];
        for (const m of messages) {
          const text =
            m.text?.body ||
            (m.type === "image" && m.image?.caption) ||
            `[${m.type} message]`;
          try {
            await processIncomingMessage(companyId, {
              phoneNumber: m.from,
              messageText: text,
              messageId: m.id,
              timestamp: m.timestamp
                ? new Date(Number(m.timestamp) * 1000)
                : new Date(),
            });
            processed++;
          } catch {
            /* continue on individual message errors */
          }
        }
      }
    }
  } catch {
    /* swallow top-level errors — webhook must return 200 to Meta */
  }

  return { processed };
}
