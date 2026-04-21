// ============================================================================
// AI AGENT SERVICE
// ----------------------------------------------------------------------------
// Orchestrates the Gemini conversation loop with tool calling. For each
// user message:
//   1. Load the thread's full message history
//   2. Call Gemini with tools + system prompt + history + new user turn
//   3. If Gemini returns a function call, execute the tool, add the
//      result to history, call Gemini again
//   4. Loop until Gemini returns a plain text response (cap at 5 tool
//      calls per turn to prevent runaway)
//   5. Persist the final user + assistant messages (plus tool calls/
//      results as intermediate messages)
//
// The loop runs server-side in one HTTP request. Average Gemini Flash
// latency is ~1-2s per call so a 3-tool-call turn finishes in ~5s —
// acceptable for chat UX with a loading indicator.
// ============================================================================

import { GoogleGenerativeAI } from "@google/generative-ai";
import { prisma } from "../config/database";
import { env } from "../config/env";
import { notFound, badRequest } from "../middleware/errorHandler";
import { SALES_AGENT_TOOLS, executeTool } from "./ai-agent-tools";

const MAX_TOOL_CALLS_PER_TURN = 5;
const MODEL_NAME = "gemini-2.0-flash";

const genAI = env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(env.GEMINI_API_KEY)
  : null;

export type AgentKind = "sales" | "content" | "meeting";

// ──────────────────────────────────────────────────────────────────────
// System prompts per agent kind
// ──────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPTS: Record<AgentKind, string> = {
  sales: `You are the Zyrix Sales Assistant — an AI sales coach embedded in the user's CRM. You help sales people make sense of their pipeline, remember who to follow up with, and draft outreach.

Rules:
- ALWAYS use the provided tools to fetch real data before answering factual questions. Never invent customer names, deal values, or stages.
- When summarizing, cite specific deal titles and customer names.
- Be concise. Prefer bullet points for lists, short paragraphs for explanations.
- For "what should I do today" questions, combine get_upcoming_tasks + get_stale_deals + get_recent_activity to give a prioritized suggestion.
- When the user asks to "draft a message" or "write an email", write the draft directly without asking too many clarifying questions — use the tool data to personalize it.
- Respond in the language the user writes in (Arabic, English, or Turkish).
- Today's date is available in the conversation context.`,

  content: `You are the Zyrix Content Writer — an AI that helps draft customer-facing messages: emails, WhatsApp, social posts. Be concise, persuasive, and match the requested tone. Always respond in the language the user requests.`,

  meeting: `You are the Zyrix Meeting Notes assistant — you extract action items, decisions, and key discussion points from meeting transcripts. Return structured output: brief summary, action items (with owner when clear), open questions, and follow-up suggestions. Always respond in the language of the transcript.`,
};

// ──────────────────────────────────────────────────────────────────────
// THREADS
// ──────────────────────────────────────────────────────────────────────

export async function listThreads(
  companyId: string,
  userId: string,
  agentKind: AgentKind
) {
  return prisma.aiThread.findMany({
    where: { companyId, userId, agentKind, archived: false },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: {
      id: true,
      title: true,
      agentKind: true,
      relatedActivityId: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function getThread(
  companyId: string,
  userId: string,
  threadId: string
) {
  const thread = await prisma.aiThread.findFirst({
    where: { id: threadId, companyId, userId },
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          role: true,
          content: true,
          toolCall: true,
          createdAt: true,
        },
      },
    },
  });
  if (!thread) throw notFound("Thread not found");
  return thread;
}

export async function createThread(
  companyId: string,
  userId: string,
  agentKind: AgentKind,
  opts?: { relatedActivityId?: string }
) {
  return prisma.aiThread.create({
    data: {
      companyId,
      userId,
      agentKind,
      relatedActivityId: opts?.relatedActivityId,
    },
    select: {
      id: true,
      agentKind: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function archiveThread(
  companyId: string,
  userId: string,
  threadId: string
) {
  const thread = await prisma.aiThread.findFirst({
    where: { id: threadId, companyId, userId },
  });
  if (!thread) throw notFound("Thread not found");
  await prisma.aiThread.update({
    where: { id: threadId },
    data: { archived: true },
  });
  return { archived: true };
}

// ──────────────────────────────────────────────────────────────────────
// SEND MESSAGE — the main conversation loop
// ──────────────────────────────────────────────────────────────────────

export async function sendMessage(
  companyId: string,
  userId: string,
  threadId: string,
  userText: string
): Promise<{ assistantMessage: string; toolCallsUsed: number }> {
  if (!genAI) {
    throw badRequest(
      "GEMINI_API_KEY is not configured — AI agents are disabled"
    );
  }
  if (!userText || userText.trim().length === 0) {
    throw badRequest("Message cannot be empty");
  }

  const thread = await prisma.aiThread.findFirst({
    where: { id: threadId, companyId, userId },
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
        select: { role: true, content: true, toolCall: true },
      },
    },
  });
  if (!thread) throw notFound("Thread not found");

  // Persist the incoming user message first so it's visible even if the
  // assistant response fails halfway through.
  await prisma.aiMessage.create({
    data: {
      threadId,
      role: "user",
      content: userText.trim(),
    },
  });

  // Build Gemini history from prior messages.
  // Gemini expects: [{ role: 'user' | 'model', parts: [{ text }] }]
  // We map tool-call messages into the model-side function-calling
  // protocol so context is preserved across turns.
  const history = buildGeminiHistory(thread.messages);

  const agentKind = thread.agentKind as AgentKind;
  const systemPrompt = SYSTEM_PROMPTS[agentKind] ?? SYSTEM_PROMPTS.sales;

  const tools =
    agentKind === "sales"
      ? [{ functionDeclarations: SALES_AGENT_TOOLS as any }]
      : undefined;

  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: `${systemPrompt}\n\nToday's date: ${new Date().toISOString()}`,
    tools,
  });

  // Open chat session. Gemini's chat API auto-accumulates state; we
  // bootstrap it with the stored history (excluding the new user turn
  // which we send separately via sendMessage to keep symmetry).
  const chat = model.startChat({ history });

  let toolCallsUsed = 0;
  let finalResponse = "";

  // Send the new user message
  let result = await chat.sendMessage(userText.trim());

  // Tool-call loop
  while (toolCallsUsed < MAX_TOOL_CALLS_PER_TURN) {
    const response = result.response;
    const functionCalls =
      typeof response.functionCalls === "function"
        ? response.functionCalls()
        : undefined;

    if (!functionCalls || functionCalls.length === 0) {
      // Plain text response — we're done
      finalResponse = response.text();
      break;
    }

    // Execute each called tool and feed results back
    const toolResults: Array<{
      functionResponse: { name: string; response: { content: unknown } };
    }> = [];

    for (const call of functionCalls) {
      toolCallsUsed++;

      // Persist the assistant's tool-call intent so it shows in the
      // conversation timeline as a tool invocation.
      await prisma.aiMessage.create({
        data: {
          threadId,
          role: "assistant",
          content: `Calling tool: ${call.name}`,
          toolCall: { name: call.name, args: call.args } as any,
        },
      });

      const toolResult = await executeTool(
        call.name,
        { companyId, userId },
        (call.args ?? {}) as Record<string, unknown>
      );

      // Persist the tool result
      await prisma.aiMessage.create({
        data: {
          threadId,
          role: "tool",
          content: `Result from ${call.name}`,
          toolCall: { name: call.name, result: toolResult } as any,
        },
      });

      toolResults.push({
        functionResponse: {
          name: call.name,
          response: { content: toolResult },
        },
      });
    }

    // Send tool responses back to Gemini — it will either call more
    // tools or produce a final text answer.
    result = await chat.sendMessage(toolResults as any);
  }

  if (!finalResponse) {
    finalResponse =
      toolCallsUsed >= MAX_TOOL_CALLS_PER_TURN
        ? "I looked at a lot of data but couldn't wrap up a final answer — could you ask a more specific question?"
        : "(no response)";
  }

  // Persist the assistant's final text answer
  await prisma.aiMessage.create({
    data: {
      threadId,
      role: "assistant",
      content: finalResponse,
    },
  });

  // Bump thread updatedAt + set title if it's the first exchange
  const messageCount = await prisma.aiMessage.count({
    where: { threadId },
  });
  if (messageCount <= 4 && !thread.title) {
    const titleFromMsg = userText.trim().slice(0, 60);
    await prisma.aiThread.update({
      where: { id: threadId },
      data: { title: titleFromMsg, updatedAt: new Date() },
    });
  } else {
    await prisma.aiThread.update({
      where: { id: threadId },
      data: { updatedAt: new Date() },
    });
  }

  return { assistantMessage: finalResponse, toolCallsUsed };
}

// ──────────────────────────────────────────────────────────────────────
// Helper: rebuild Gemini chat history from persisted messages
// ──────────────────────────────────────────────────────────────────────
// Gemini's chat session expects a specific alternating user/model
// structure. We map our message log into that shape, skipping tool
// messages (Gemini's session tracks function calls internally from the
// prior turn; we're only rebuilding on session start so the prior
// tool-use state is already encoded in the plain-text responses that
// followed it).
//
// For v1 simplicity we just send the user/assistant text messages —
// this means Gemini doesn't have context about which specific rows
// from earlier tool calls are being referenced. Good enough for short
// conversations; future enhancement can serialize tool results into
// the history.

function buildGeminiHistory(
  messages: { role: string; content: string; toolCall: unknown }[]
): Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> {
  const history: Array<{
    role: "user" | "model";
    parts: Array<{ text: string }>;
  }> = [];
  for (const m of messages) {
    if (m.role === "user") {
      history.push({ role: "user", parts: [{ text: m.content }] });
    } else if (m.role === "assistant" && !m.toolCall) {
      // Skip assistant messages that were just tool-call intents —
      // the real answers are in role='assistant' WITHOUT toolCall.
      history.push({ role: "model", parts: [{ text: m.content }] });
    }
  }
  return history;
}

// ──────────────────────────────────────────────────────────────────────
// CONTENT WRITER — one-shot generation (no tool calling, no history)
// ──────────────────────────────────────────────────────────────────────
// Used by the Content Writer agent. Takes a prompt + optional context
// (customer name, deal title, tone) and returns a draft. Simpler than
// the sales loop — no tools, just prompt → response.

export async function generateContent(opts: {
  kind: "email" | "whatsapp" | "social";
  prompt: string;
  tone?: string;
  language?: "ar" | "en" | "tr";
  context?: Record<string, string>;
}): Promise<{ draft: string }> {
  if (!genAI) {
    throw badRequest(
      "GEMINI_API_KEY is not configured — AI agents are disabled"
    );
  }
  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: SYSTEM_PROMPTS.content,
  });

  const contextBlock = opts.context
    ? `\n\nContext:\n${Object.entries(opts.context)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join("\n")}`
    : "";
  const toneLine = opts.tone ? `\nTone: ${opts.tone}` : "";
  const langLine = opts.language ? `\nLanguage: ${opts.language}` : "";

  const kindLabel =
    opts.kind === "email"
      ? "Write an email"
      : opts.kind === "whatsapp"
        ? "Write a WhatsApp message"
        : "Write a social media post";

  const fullPrompt = `${kindLabel}.${toneLine}${langLine}\n\nRequest: ${opts.prompt}${contextBlock}\n\nOutput the draft only — no preamble.`;

  const result = await model.generateContent(fullPrompt);
  const draft = result.response.text();
  return { draft };
}

// ──────────────────────────────────────────────────────────────────────
// MEETING NOTES — transcript → structured notes
// ──────────────────────────────────────────────────────────────────────

export async function extractMeetingNotes(opts: {
  transcript: string;
  language?: "ar" | "en" | "tr";
}): Promise<{
  summary: string;
  actionItems: Array<{ owner?: string; task: string }>;
  decisions: string[];
  openQuestions: string[];
}> {
  if (!genAI) {
    throw badRequest(
      "GEMINI_API_KEY is not configured — AI agents are disabled"
    );
  }
  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: SYSTEM_PROMPTS.meeting,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          actionItems: {
            type: "array",
            items: {
              type: "object",
              properties: {
                owner: { type: "string" },
                task: { type: "string" },
              },
              required: ["task"],
            },
          },
          decisions: { type: "array", items: { type: "string" } },
          openQuestions: { type: "array", items: { type: "string" } },
        },
        required: ["summary", "actionItems", "decisions", "openQuestions"],
      } as any,
    },
  });

  const langLine = opts.language ? `Respond in ${opts.language}.\n\n` : "";
  const prompt = `${langLine}Transcript:\n${opts.transcript}`;

  const result = await model.generateContent(prompt);
  const raw = result.response.text();
  try {
    return JSON.parse(raw);
  } catch {
    return {
      summary: raw.slice(0, 500),
      actionItems: [],
      decisions: [],
      openQuestions: [],
    };
  }
}
