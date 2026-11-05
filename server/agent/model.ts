import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { wrapLanguageModel, type LanguageModel } from "ai";
import { aiChain, config, specLabel, type AiModelSpec } from "../config.ts";

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

function providerModel(spec: AiModelSpec): Model {
  if (spec.provider === "groq") {
    if (!config.groqApiKey) throw new Error(`${specLabel(spec)} needs GROQ_API_KEY`);
    return groqModel(spec.model);
  }
  if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY is not set");
  return createGoogleGenerativeAI({ apiKey: config.geminiApiKey })(spec.model) as Model;
}

// ------------------------------------------------------------------ error classification

/** Overloaded or rate-limited provider: worth switching to the next model (429, 503, 529). */
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

/** All text an error carries: message, response body (Gemini quota details live there), nested causes. */
function errorText(err: unknown): string {
  const out: string[] = [];
  walk(err, (e) => {
    if (typeof e.message === "string") out.push(e.message);
    if (typeof e.responseBody === "string") out.push(e.responseBody.slice(0, 4000));
    return false;
  });
  return out.join("\n");
}

function statusOf(err: unknown): number | undefined {
  let s: number | undefined;
  walk(err, (e) => {
    const v = e.statusCode ?? e.status;
    if (typeof v === "number") s = v;
    return typeof v === "number";
  });
  return s;
}

function retryAfterHeader(err: unknown): number | undefined {
  let ms: number | undefined;
  walk(err, (e) => {
    const h = e.responseHeaders?.["retry-after"];
    if (h != null && Number.isFinite(Number(h))) ms = Number(h) * 1000;
    return ms !== undefined;
  });
  return ms;
}

/** "34.6s", "5m10.2s", "1h2m3s", "450ms" -> milliseconds. */
function durationMs(s: string): number | undefined {
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let any = false;
  for (const m of s.matchAll(re)) {
    any = true;
    const n = Number(m[1]);
    total += m[2] === "ms" ? n : m[2] === "s" ? n * 1000 : m[2] === "m" ? n * 60_000 : n * 3_600_000;
  }
  return any ? total : undefined;
}

/** Provider's own retry hint: Gemini "Please retry in 34.6s" / retryDelay "34s", Groq "try again in 5m10s", Retry-After. */
function retryHint(err: unknown, text: string): number | undefined {
  const m =
    /(?:retry|try again) in ((?:\d+(?:\.\d+)?(?:ms|h|m|s))+)/i.exec(text) ?? /"retryDelay"\s*:\s*"((?:\d+(?:\.\d+)?(?:ms|h|m|s))+)"/i.exec(text);
  return (m ? durationMs(m[1]) : undefined) ?? retryAfterHeader(err);
}

/** Milliseconds until the next midnight in America/Los_Angeles (Gemini daily quotas reset then). */
export function msUntilPacificMidnight(now: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(now));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const elapsed = (((get("hour") % 24) * 60 + get("minute")) * 60 + get("second")) * 1000; // "24" = midnight in some ICU builds
  return Math.max(60_000, 86_400_000 - elapsed);
}

export type FailureKind = "daily" | "minute" | "overload" | "unavailable" | "fatal";

const MIN = 60_000;
const HOUR = 3_600_000;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * What a failed call means for the chain, and how long to skip that model.
 * - daily: a per-day quota (Gemini "PerDay" quota id, Groq "tokens per day (TPD)"). Skip until the
 *   provider's hint when it is at least a minute (Groq gives one), else until Pacific midnight
 *   (Gemini's reset), at most an hour, so a wrong guess costs one probe an hour.
 * - minute: any other 429 / RESOURCE_EXHAUSTED. Skip for the provider's hint, 5 s to 5 min, default 60 s.
 * - overload: 503 / 529 / "high demand". Retried once on the same model, then skipped for 30 s.
 * - unavailable: 401 / 403 / 404 (bad key, model not enabled). Skipped for an hour.
 * - fatal: anything else (bad request, tool schema...). Thrown; another model would not help.
 */
export function classifyFailure(err: unknown, now = Date.now()): { kind: FailureKind; cooldownMs: number } {
  const status = statusOf(err);
  const text = errorText(err);
  const quota = status === 429 || /RESOURCE_EXHAUSTED|rate limit|quota/i.test(text);
  if (quota) {
    const hint = retryHint(err, text);
    if (/PerDay|per day|\bTPD\b|\bRPD\b|daily/i.test(text)) {
      if (hint !== undefined && hint >= MIN) return { kind: "daily", cooldownMs: Math.min(hint, 24 * HOUR) };
      return { kind: "daily", cooldownMs: Math.min(msUntilPacificMidnight(now), HOUR) };
    }
    return { kind: "minute", cooldownMs: clamp(hint ?? MIN, 5_000, 5 * MIN) };
  }
  if (isCapacityError(err)) return { kind: "overload", cooldownMs: 30_000 };
  if (status === 401 || status === 403 || status === 404) return { kind: "unavailable", cooldownMs: HOUR };
  return { kind: "fatal", cooldownMs: 0 };
}

// ------------------------------------------------------------------ the chain

/** Process-wide "skip until" per model label: quotas belong to the API key, not to a session. */
export class Cooldowns {
  private until = new Map<string, number>();
  constructor(private now: () => number = Date.now) {}
  set(label: string, ms: number) {
    this.until.set(label, this.now() + ms);
  }
  /** Milliseconds left, 0 when the model may be tried. */
  left(label: string): number {
    const u = this.until.get(label);
    if (u === undefined) return 0;
    const left = u - this.now();
    if (left <= 0) this.until.delete(label);
    return Math.max(0, left);
  }
  clear() {
    this.until.clear();
  }
}

export const cooldowns = new Cooldowns();

export interface ChainMember {
  label: string;
  model: Model;
}

export interface ChainOptions {
  onActive?: (label: string) => void;
  cooldowns?: Cooldowns;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One LanguageModel that tries `members` in order. A model cooling down (after a 429, a quota error
 * or an outage) is skipped; a model that fails that way gets a cooldown (classifyFailure) and the call
 * moves to the next one. When every member is cooling down, the one whose cooldown ends first is tried.
 * Within one request (one returned model) later steps start at the member that last answered, so a
 * multi-step agent turn does not hop back to a model that just failed. `onActive` gets the label of
 * the member that answered each call.
 */
export function chainModel(members: ChainMember[], opts: ChainOptions = {}): Model {
  if (!members.length) throw new Error("The AI model chain is empty.");
  const cd = opts.cooldowns ?? cooldowns;
  const sleep = opts.sleep ?? realSleep;
  const log = opts.log ?? ((m: string) => console.warn(m));
  let start = 0;

  async function run<T>(call: (m: Model) => PromiseLike<T>): Promise<T> {
    let lastError: unknown;
    const order = members.map((_, i) => i).filter((i) => i >= start);
    let tried = 0;
    for (const i of order) {
      const member = members[i];
      const wait = cd.left(member.label);
      if (wait > 0) continue;
      tried++;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await call(member.model);
          start = i;
          opts.onActive?.(member.label);
          return r;
        } catch (e) {
          const f = classifyFailure(e, (opts.now ?? Date.now)());
          if (f.kind === "fatal") throw e;
          lastError = e;
          if (f.kind === "overload" && attempt === 0) {
            await sleep(1500);
            continue;
          }
          cd.set(member.label, f.cooldownMs);
          const next = members.slice(i + 1).find((m) => cd.left(m.label) === 0);
          log(
            `[ai] ${member.label} ${f.kind === "daily" ? "daily quota exhausted" : f.kind === "minute" ? "rate-limited" : f.kind}` +
              ` (${oneLine(e)}); skipping it for ${Math.round(f.cooldownMs / 1000)}s` +
              (next ? `, trying ${next.label}` : ""),
          );
          break;
        }
      }
    }
    if (tried === 0) {
      // Everything is cooling down: the cooldowns are estimates, so try the soonest one once.
      const soonest = order.reduce((a, b) => (cd.left(members[b].label) < cd.left(members[a].label) ? b : a), order[0] ?? 0);
      const member = members[soonest];
      log(`[ai] every model is cooling down; trying ${member.label} anyway`);
      try {
        const r = await call(member.model);
        start = soonest;
        opts.onActive?.(member.label);
        return r;
      } catch (e) {
        const f = classifyFailure(e, (opts.now ?? Date.now)());
        if (f.kind !== "fatal") cd.set(member.label, f.cooldownMs);
        throw e;
      }
    }
    throw lastError;
  }

  const first = members[0].model;
  return {
    specificationVersion: "v4",
    provider: first.provider,
    modelId: first.modelId,
    supportedUrls: first.supportedUrls,
    doGenerate: (params) => run((m) => m.doGenerate(params)),
    doStream: (params) => run((m) => m.doStream(params)),
  } as Model;
}

function oneLine(e: unknown): string {
  return String((e as Error)?.message ?? e)
    .replace(/\s+/g, " ")
    .slice(0, 140);
}

/** The configured chain (config.aiChain) as provider models; members whose API key is missing are left out. */
export function chainMembers(specs: AiModelSpec[] = aiChain()): ChainMember[] {
  const members: ChainMember[] = [];
  let firstError: unknown;
  for (const spec of specs) {
    try {
      members.push({ label: specLabel(spec), model: providerModel(spec) });
    } catch (e) {
      firstError ??= e;
    }
  }
  if (!members.length) throw firstError;
  return members;
}

/**
 * A model for one request (a chat turn or a gift-list parse): the configured chain (AI_MODEL, then
 * the other Gemini flash models, then Groq gpt-oss-120b and gpt-oss-20b). Provider clients are built
 * per request; cooldowns are shared by the whole process.
 */
export function model(onActive?: (label: string) => void): LanguageModel {
  return chainModel(chainMembers(), { onActive });
}

export const RATE_LIMIT_MESSAGE =
  "The AI model is busy or rate-limited right now (free tier). Please wait about a minute and try again. Nothing was bought.";
