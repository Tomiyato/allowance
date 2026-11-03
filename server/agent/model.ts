import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { wrapLanguageModel, type LanguageModel } from "ai";
import { aiModelId, config } from "../config.ts";

type Model = LanguageModelV4;

/**
 * Groq rejects assistant messages carrying `reasoning_content` (which the OpenAI-compatible provider
 * emits for reasoning parts from earlier steps, e.g. gpt-oss or a Gemini step before a fallback).
 * Strip reasoning parts from the history before every Groq call.
 */
function stripReasoning(params: LanguageModelV4CallOptions): LanguageModelV4CallOptions {
  return {
    ...params,
    prompt: params.prompt.map((m) =>
      m.role === "assistant" ? { ...m, content: m.content.filter((p) => p.type !== "reasoning") } : m,
    ) as LanguageModelV4CallOptions["prompt"],
  };
}

function groqModel(id: string): Model {
  const groq = createOpenAICompatible({
    name: "groq",
    baseURL: "https://api.groq.com/openai/v1",
    apiKey: config.groqApiKey,
    supportsStructuredOutputs: true, // Groq accepts response_format json_schema
  });
  return wrapLanguageModel({
    model: groq.chatModel(id) as Model,
    middleware: { specificationVersion: "v4", transformParams: async ({ params }) => stripReasoning(params) },
  });
}

function primaryModel(): Model {
  if (config.aiProvider === "groq") {
    if (!config.groqApiKey) throw new Error("AI_PROVIDER=groq but GROQ_API_KEY is not set");
    return groqModel(aiModelId());
  }
  if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY is not set");
  return createGoogleGenerativeAI({ apiKey: config.geminiApiKey })(aiModelId()) as Model;
}

/**
 * Fallback for a Google primary, from AI_FALLBACK_MODEL="provider:model"
 * (default "groq:openai/gpt-oss-120b"; "google:gemini-3.6-flash" also works). AI_FALLBACK=off disables it.
 */
export function fallbackSpec(): { provider: "groq" | "google"; model: string } | null {
  if (config.aiProvider !== "google" || process.env.AI_FALLBACK === "off") return null;
  const raw = process.env.AI_FALLBACK_MODEL?.trim() || "groq:openai/gpt-oss-120b";
  const i = raw.indexOf(":");
  const provider = raw.slice(0, i) === "google" ? "google" : "groq";
  if (provider === "groq" && !config.groqApiKey) return null;
  return { provider, model: raw.slice(i + 1) };
}

function fallbackModel(): Model | null {
  const spec = fallbackSpec();
  if (!spec) return null;
  return spec.provider === "groq"
    ? groqModel(spec.model)
    : (createGoogleGenerativeAI({ apiKey: config.geminiApiKey })(spec.model) as Model);
}

/** Overloaded or rate-limited provider: worth switching to the fallback (429, 503, 529). */
export function isCapacityError(err: unknown): boolean {
  return walk(err, (e) => [429, 503, 529].includes(e.statusCode ?? e.status) || /RESOURCE_EXHAUSTED|UNAVAILABLE|high demand|overloaded/i.test(e.message ?? ""));
}

/** True for provider rate-limit / quota / overload errors, including wrapped retry errors. */
export function isRateLimit(err: unknown): boolean {
  return isCapacityError(err) || walk(err, (e) => typeof e.message === "string" && /\b429\b|rate limit|quota/i.test(e.message));
}

function walk(err: unknown, test: (e: any) => boolean): boolean {
  const seen = new Set<unknown>();
  const stack: any[] = [err];
  while (stack.length) {
    const e = stack.pop();
    if (!e || typeof e !== "object" || seen.has(e)) continue;
    seen.add(e);
    if (test(e)) return true;
    if (Array.isArray(e.errors)) stack.push(...e.errors);
    stack.push(e.lastError, e.cause);
  }
  return false;
}

/** Quota exhausted (429 / RESOURCE_EXHAUSTED): retrying the same provider soon is pointless. */
function isQuotaError(err: unknown): boolean {
  return walk(err, (e) => (e.statusCode ?? e.status) === 429 || /RESOURCE_EXHAUSTED|quota/i.test(e.message ?? ""));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A model for one request. Gemini free tier is small (5 requests/minute for gemini-3.8-flash) and
 * sometimes answers 503 "high demand". On 503 the primary is retried once after a short backoff;
 * if it is still unavailable, or the quota is exhausted (429), the call goes to the Groq fallback
 * and the rest of the request sticks to it. Without a fallback, streamText's own maxRetries
 * (exponential backoff) handles retries.
 */
export function model(): LanguageModel {
  const primary = primaryModel();
  const fallback = fallbackModel();
  if (!fallback) return primary;
  let useFallback = false;

  async function run<T>(callPrimary: () => PromiseLike<T>, callFallback: () => PromiseLike<T>): Promise<T> {
    if (!useFallback) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await callPrimary();
        } catch (e) {
          if (!isCapacityError(e)) throw e;
          if (attempt === 0 && !isQuotaError(e)) {
            await sleep(1500);
            continue;
          }
          console.warn(`[ai] ${config.aiProvider} unavailable (${(e as Error).message?.slice(0, 100)}); falling back to ${fallbackSpec()?.provider}:${fallbackSpec()?.model}`);
          useFallback = true;
          break;
        }
      }
    }
    return callFallback();
  }

  return wrapLanguageModel({
    model: primary,
    middleware: {
      specificationVersion: "v4",
      wrapStream: ({ doStream, params }) => run(doStream, () => fallback.doStream(params)),
      wrapGenerate: ({ doGenerate, params }) => run(doGenerate, () => fallback.doGenerate(params)),
    },
  });
}

export const RATE_LIMIT_MESSAGE =
  "The AI model is busy or rate-limited right now (free tier). Please wait about a minute and try again. Nothing was bought.";
