// AI model chain (server/agent/model.ts + config.aiChain): order, skip on 429, cooldowns, ai_active labels.
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, type LanguageModelV4 } from "@ai-sdk/provider";
import { generateText, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import { aiChain, specLabel } from "../config.ts";
import { chainModel, classifyFailure, Cooldowns, msUntilPacificMidnight, type ChainMember } from "./model.ts";

const KEYS = { google: true, groq: true };
const labels = (env: Record<string, string>, keys = KEYS) => aiChain(env, keys).map(specLabel);

describe("aiChain (config)", () => {
  it("defaults to the Render setting's model, the other Gemini flash models, then Groq 120b and 20b", () => {
    expect(labels({ AI_PROVIDER: "google", AI_MODEL: "gemini-3.6-flash" })).toEqual([
      "google:gemini-3.6-flash",
      "google:gemini-3.8-flash",
      "google:gemini-3.7-flash",
      "groq:openai/gpt-oss-120b",
      "groq:openai/gpt-oss-20b",
    ]);
  });

  it("starts at gemini-3.8-flash when AI_MODEL is unset", () => {
    expect(labels({})[0]).toBe("google:gemini-3.8-flash");
    expect(labels({})).toHaveLength(5);
  });

  it("takes a comma-separated AI_MODEL as the whole chain, inferring providers", () => {
    expect(labels({ AI_MODEL: "openai/gpt-oss-20b, gemini-3.7-flash ,groq:openai/gpt-oss-120b" })).toEqual([
      "groq:openai/gpt-oss-20b",
      "google:gemini-3.7-flash",
      "groq:openai/gpt-oss-120b",
    ]);
  });

  it("drops members whose provider has no API key, but keeps the primary", () => {
    expect(labels({ AI_MODEL: "gemini-3.6-flash" }, { google: true, groq: false })).toEqual([
      "google:gemini-3.6-flash",
      "google:gemini-3.8-flash",
      "google:gemini-3.7-flash",
    ]);
  });

  it("keeps the legacy switches: AI_FALLBACK=off and AI_FALLBACK_MODEL", () => {
    expect(labels({ AI_MODEL: "gemini-3.6-flash", AI_FALLBACK: "off" })).toEqual(["google:gemini-3.6-flash"]);
    expect(labels({ AI_MODEL: "gemini-3.6-flash", AI_FALLBACK_MODEL: "groq:openai/gpt-oss-20b" })).toEqual([
      "google:gemini-3.6-flash",
      "groq:openai/gpt-oss-20b",
    ]);
  });

  it("a Groq primary tries the other Groq model before Gemini", () => {
    expect(labels({ AI_PROVIDER: "groq" })).toEqual([
      "groq:openai/gpt-oss-120b",
      "groq:openai/gpt-oss-20b",
      "google:gemini-3.8-flash",
      "google:gemini-3.7-flash",
      "google:gemini-3.6-flash",
    ]);
  });
});

// ------------------------------------------------------------------ errors as the providers send them

/** Gemini free-tier 429, shape as returned by generativelanguage.googleapis.com. */
function geminiQuotaBody(perDay: boolean, model = "gemini-3.6-flash") {
  return JSON.stringify({
    error: {
      code: 429,
      message:
        "You exceeded your current quota, please check your plan and billing details.\n" +
        `* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: ${perDay ? 20 : 5}, model: ${model}\n` +
        "Please retry in 41.57s.",
      status: "RESOURCE_EXHAUSTED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [
            {
              quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
              quotaId: perDay ? "GenerateRequestsPerDayPerProjectPerModel-FreeTier" : "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
              quotaValue: perDay ? "20" : "5",
            },
          ],
        },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "41s" },
      ],
    },
  });
}

function apiError(statusCode: number, message: string, responseBody?: string, responseHeaders?: Record<string, string>) {
  return new APICallError({ message, url: "https://example.test", requestBodyValues: {}, statusCode, responseBody, responseHeaders, isRetryable: statusCode === 429 || statusCode >= 500 });
}

describe("classifyFailure", () => {
  const now = Date.UTC(2026, 10, 5, 12, 0, 0); // 04:00 in Los Angeles: 20 h to Pacific midnight

  it("Gemini per-minute 429: skip briefly, using the provider's retry hint", () => {
    expect(classifyFailure(apiError(429, "quota", geminiQuotaBody(false)), now)).toEqual({ kind: "minute", cooldownMs: 41_570 });
  });

  it("Gemini daily quota: skip until Pacific midnight, at most an hour (its 41 s hint is not the reset)", () => {
    expect(classifyFailure(apiError(429, "quota", geminiQuotaBody(true)), now)).toEqual({ kind: "daily", cooldownMs: 3_600_000 });
    const late = Date.UTC(2026, 11, 1, 7, 50, 0); // 23:50 PST: reset in 10 minutes
    expect(classifyFailure(apiError(429, "quota", geminiQuotaBody(true)), late)).toEqual({ kind: "daily", cooldownMs: 600_000 });
  });

  it("Groq tokens-per-day limit: skip for Groq's own 'try again in'", () => {
    const msg =
      "Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 199644, Requested 1210. Please try again in 6m9.8s.";
    expect(classifyFailure(apiError(429, msg), now)).toEqual({ kind: "daily", cooldownMs: 369_800 });
  });

  it("Groq per-minute limit and a bare 429", () => {
    const msg = "Rate limit reached for model `openai/gpt-oss-20b` on tokens per minute (TPM): Limit 8000, Used 7000, Requested 2000. Please try again in 7.5s.";
    expect(classifyFailure(apiError(429, msg), now)).toEqual({ kind: "minute", cooldownMs: 7_500 });
    expect(classifyFailure(apiError(429, "Too Many Requests", undefined, { "retry-after": "12" }), now)).toEqual({ kind: "minute", cooldownMs: 12_000 });
    expect(classifyFailure(apiError(429, "Too Many Requests"), now)).toEqual({ kind: "minute", cooldownMs: 60_000 });
  });

  it("503 is an overload, 404 is unavailable, 400 is fatal", () => {
    expect(classifyFailure(apiError(503, "The model is overloaded."), now).kind).toBe("overload");
    expect(classifyFailure(apiError(404, "models/gemini-3.7-flash is not found"), now)).toEqual({ kind: "unavailable", cooldownMs: 3_600_000 });
    expect(classifyFailure(apiError(400, "Invalid JSON payload"), now).kind).toBe("fatal");
  });

  it("Pacific midnight math", () => {
    expect(msUntilPacificMidnight(Date.UTC(2026, 10, 5, 12, 0, 0))).toBe(20 * 3_600_000); // PDT (UTC-7)
    expect(msUntilPacificMidnight(Date.UTC(2026, 11, 1, 7, 0, 0))).toBe(3_600_000); // PST (UTC-8)
  });
});

// ------------------------------------------------------------------ the chain

const ok = (text: string) =>
  ({
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
    warnings: [],
  }) as any;

function member(label: string, behave: () => any): ChainMember & { calls: () => number } {
  let n = 0;
  const model = new MockLanguageModelV4({
    modelId: label,
    doGenerate: async () => {
      n++;
      return behave();
    },
  });
  return { label, model: model as LanguageModelV4, calls: () => n };
}

const rateLimited = () => {
  throw apiError(429, "quota", geminiQuotaBody(false));
};
const dailyLimited = () => {
  throw apiError(429, "quota", geminiQuotaBody(true));
};

describe("chainModel", () => {
  let clock = Date.UTC(2026, 10, 5, 12, 0, 0);
  let cd: Cooldowns;
  const log: string[] = [];
  const opts = (onActive?: (l: string) => void) => ({ cooldowns: cd, now: () => clock, sleep: async () => {}, log: (m: string) => log.push(m), onActive });

  beforeEach(() => {
    clock = Date.UTC(2026, 10, 5, 12, 0, 0);
    cd = new Cooldowns(() => clock);
    log.length = 0;
  });

  it("skips a model that answers 429 and reports the one that answered", async () => {
    const a = member("google:gemini-3.6-flash", rateLimited);
    const b = member("google:gemini-3.8-flash", () => ok("from 3.8"));
    const active: string[] = [];
    const { text } = await generateText({ model: chainModel([a, b], opts((l) => active.push(l))), prompt: "hi", maxRetries: 0 });
    expect(text).toBe("from 3.8");
    expect(active).toEqual(["google:gemini-3.8-flash"]);
    expect(a.calls()).toBe(1);
    expect(cd.left("google:gemini-3.6-flash")).toBe(41_570);
    expect(log[0]).toMatch(/gemini-3\.6-flash rate-limited .*skipping it for 42s, trying google:gemini-3\.8-flash/);
  });

  it("does not call a cooling-down model again until its cooldown expires", async () => {
    let fail = true;
    const a = member("google:gemini-3.6-flash", () => (fail ? rateLimited() : ok("from 3.6")));
    const b = member("groq:openai/gpt-oss-120b", () => ok("from groq"));
    await generateText({ model: chainModel([a, b], opts()), prompt: "1", maxRetries: 0 });
    fail = false;
    clock += 30_000; // still cooling (41.57 s)
    const active: string[] = [];
    const r2 = await generateText({ model: chainModel([a, b], opts((l) => active.push(l))), prompt: "2", maxRetries: 0 });
    expect(r2.text).toBe("from groq");
    expect(a.calls()).toBe(1);
    clock += 15_000; // cooldown over
    const r3 = await generateText({ model: chainModel([a, b], opts((l) => active.push(l))), prompt: "3", maxRetries: 0 });
    expect(r3.text).toBe("from 3.6");
    expect(a.calls()).toBe(2);
    expect(active).toEqual(["groq:openai/gpt-oss-120b", "google:gemini-3.6-flash"]);
  });

  it("walks the chain in order past several exhausted models", async () => {
    const order: string[] = [];
    const mk = (label: string, fn: () => any) => member(label, () => (order.push(label), fn()));
    const chain = [
      mk("google:gemini-3.6-flash", dailyLimited),
      mk("google:gemini-3.8-flash", dailyLimited),
      mk("google:gemini-3.7-flash", rateLimited),
      mk("groq:openai/gpt-oss-120b", () => ok("from 120b")),
      mk("groq:openai/gpt-oss-20b", () => ok("from 20b")),
    ];
    const active: string[] = [];
    const { text } = await generateText({ model: chainModel(chain, opts((l) => active.push(l))), prompt: "hi", maxRetries: 0 });
    expect(text).toBe("from 120b");
    expect(order).toEqual(["google:gemini-3.6-flash", "google:gemini-3.8-flash", "google:gemini-3.7-flash", "groq:openai/gpt-oss-120b"]);
    expect(active).toEqual(["groq:openai/gpt-oss-120b"]);
    expect(cd.left("google:gemini-3.6-flash")).toBe(3_600_000); // daily
    expect(cd.left("google:gemini-3.7-flash")).toBe(41_570); // per-minute
  });

  it("sticks to the member that answered for later steps of the same request", async () => {
    let first = true;
    const a = member("google:gemini-3.6-flash", () => (first ? ((first = false), rateLimited()) : ok("3.6 again")));
    const b = member("google:gemini-3.8-flash", () => ok("from 3.8"));
    const m = chainModel([a, b], opts());
    await m.doGenerate({ prompt: [] } as any);
    clock += 120_000; // a's cooldown is over, but this request already moved on
    const r = await m.doGenerate({ prompt: [] } as any);
    expect((r.content[0] as any).text).toBe("from 3.8");
    expect(a.calls()).toBe(1);
  });

  it("retries an overloaded model once before moving on", async () => {
    let n = 0;
    const a = member("google:gemini-3.6-flash", () => (n++ === 0 ? (() => { throw apiError(503, "This model is currently experiencing high demand."); })() : ok("3.6 after retry")));
    const b = member("google:gemini-3.8-flash", () => ok("from 3.8"));
    const { text } = await generateText({ model: chainModel([a, b], opts()), prompt: "hi", maxRetries: 0 });
    expect(text).toBe("3.6 after retry");
    expect(b.calls()).toBe(0);
  });

  it("throws a non-capacity error without trying the next model", async () => {
    const a = member("google:gemini-3.6-flash", () => {
      throw apiError(400, "Invalid JSON payload received.");
    });
    const b = member("google:gemini-3.8-flash", () => ok("from 3.8"));
    await expect(generateText({ model: chainModel([a, b], opts()), prompt: "hi", maxRetries: 0 })).rejects.toThrow(/Invalid JSON payload/);
    expect(b.calls()).toBe(0);
  });

  it("when every model is cooling down, tries the one that frees up first", async () => {
    const a = member("google:gemini-3.6-flash", () => ok("from 3.6"));
    const b = member("groq:openai/gpt-oss-120b", () => ok("from groq"));
    cd.set(a.label, 3_600_000);
    cd.set(b.label, 10_000);
    const active: string[] = [];
    const { text } = await generateText({ model: chainModel([a, b], opts((l) => active.push(l))), prompt: "hi", maxRetries: 0 });
    expect(text).toBe("from groq");
    expect(active).toEqual(["groq:openai/gpt-oss-120b"]);
    expect(log.at(-1)).toMatch(/every model is cooling down/);
  });

  it("rethrows the last capacity error when the whole chain is exhausted", async () => {
    const a = member("google:gemini-3.6-flash", rateLimited);
    const b = member("groq:openai/gpt-oss-20b", rateLimited);
    await expect(generateText({ model: chainModel([a, b], opts()), prompt: "hi", maxRetries: 0 })).rejects.toThrow(/quota/);
  });
});

// ------------------------------------------------------------------ real provider clients, fake HTTP

describe("chain with the real Google and Groq clients (fake fetch)", () => {
  it("streams from Groq after Gemini answers 429, and reports groq:openai/gpt-oss-120b as ai_active", async () => {
    const calls: string[] = [];
    const geminiFetch = (async (url: any) => {
      calls.push(String(url));
      return new Response(geminiQuotaBody(true), { status: 429, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const sse = [
      { id: "c1", object: "chat.completion.chunk", created: 1, model: "openai/gpt-oss-120b", choices: [{ index: 0, delta: { role: "assistant", content: "Hello from Groq" }, finish_reason: null }] },
      { id: "c1", object: "chat.completion.chunk", created: 1, model: "openai/gpt-oss-120b", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 } },
    ]
      .map((c) => `data: ${JSON.stringify(c)}\n\n`)
      .join("") + "data: [DONE]\n\n";
    const groqFetch = (async (url: any) => {
      calls.push(String(url));
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    const google = createGoogleGenerativeAI({ apiKey: "test", fetch: geminiFetch });
    const groq = createOpenAICompatible({ name: "groq", baseURL: "https://api.groq.com/openai/v1", apiKey: "test", fetch: groqFetch });
    const cd = new Cooldowns(() => Date.UTC(2026, 10, 5, 12, 0, 0));
    const session = { ai_active: null as string | null }; // what chat.ts stores and the UI shows
    const log: string[] = [];
    const m = chainModel(
      [
        { label: "google:gemini-3.6-flash", model: google("gemini-3.6-flash") as LanguageModelV4 },
        { label: "groq:openai/gpt-oss-120b", model: groq.chatModel("openai/gpt-oss-120b") as LanguageModelV4 },
      ],
      { cooldowns: cd, log: (x) => log.push(x), sleep: async () => {}, onActive: (l) => (session.ai_active = l) },
    );
    const result = streamText({ model: m, prompt: "hi", maxRetries: 0 });
    expect(await result.text).toBe("Hello from Groq");
    expect(session.ai_active).toBe("groq:openai/gpt-oss-120b");
    expect(calls[0]).toMatch(/generativelanguage\.googleapis\.com.*gemini-3\.6-flash/);
    expect(calls[1]).toMatch(/api\.groq\.com\/openai\/v1\/chat\/completions/);
    expect(log[0]).toMatch(/google:gemini-3\.6-flash daily quota exhausted/);
    console.log(`[demo] ${log[0]}\n[demo] ai_active = ${session.ai_active}`);
  });
});
