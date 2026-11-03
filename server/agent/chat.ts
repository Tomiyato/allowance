// POST /api/chat: AI SDK v7 UI message stream consumed by @ai-sdk/react useChat.
import type { Request, Response } from "express";
import { convertToModelMessages, isStepCount, streamText, type UIMessage } from "ai";
import { addLedger, refreshMandateStatus, remaining, touch, type Session } from "../store.ts";
import { isRateLimit, model, RATE_LIMIT_MESSAGE } from "./model.ts";
import { agentInstructions } from "./prompt.ts";
import { buildTools } from "./tools.ts";

const MAX_HISTORY = 16;
const MAX_STEPS = 6;

function lastUserText(messages: UIMessage[]): string {
  const m = [...messages].reverse().find((x) => x.role === "user");
  return (m?.parts ?? [])
    .map((p: any) => (p.type === "text" ? p.text : ""))
    .join(" ")
    .trim();
}

function friendlyError(err: unknown): string {
  if (isRateLimit(err)) return RATE_LIMIT_MESSAGE;
  console.error("[chat] error:", err);
  return "Something went wrong talking to the AI model. Please try again.";
}

export async function handleChat(req: Request, res: Response, session: Session, baseUrl: string) {
  const messages = req.body?.messages as UIMessage[] | undefined;
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "Body must be { messages: UIMessage[] }" });
    return;
  }

  // Keep the prompt small: last N messages, starting at a user turn.
  let recent = messages.slice(-MAX_HISTORY);
  const firstUser = recent.findIndex((m) => m.role === "user");
  recent = firstUser > 0 ? recent.slice(firstUser) : recent;

  const text = lastUserText(recent);
  if (text) addLedger(session, { actor: "user", action: "agent.task", summary: `You asked the agent: "${text.slice(0, 160)}"` });

  refreshMandateStatus(session);
  const tools = buildTools({ session, baseUrl });

  let modelMessages;
  try {
    modelMessages = await convertToModelMessages(recent, { tools, ignoreIncompleteToolCalls: true });
  } catch (e) {
    res.status(400).json({ error: `Invalid messages: ${(e as Error).message}` });
    return;
  }

  const result = streamText({
    model: model((label) => {
      // Every model call of the turn reports in; the last one is the provider that produced the final step.
      session.ai_active = label;
      touch(session);
    }),
    instructions: agentInstructions(session.mandate, remaining(session)),
    messages: modelMessages,
    tools,
    stopWhen: isStepCount(MAX_STEPS),
    maxRetries: 2,
    onError: ({ error }) => {
      if (!isRateLimit(error)) console.error("[chat] stream error:", error);
    },
  });

  result.pipeUIMessageStreamToResponse(res, {
    originalMessages: messages,
    onError: friendlyError,
  });
}
