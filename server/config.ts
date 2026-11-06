// Runtime configuration from environment variables (see .env.example).
import type { PaymentMode } from "../shared/types.ts";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

const hasPayPalKeys = Boolean(env("PAYPAL_CLIENT_ID") && env("PAYPAL_CLIENT_SECRET"));

function paymentMode(): PaymentMode {
  const requested = env("PAYMENT_MODE") as PaymentMode | undefined;
  const allowed: PaymentMode[] = ["mock", "authorization", "per_purchase", "vault"];
  if (requested && !allowed.includes(requested)) {
    console.warn(`[config] Unknown PAYMENT_MODE=${requested}; using mock.`);
    return "mock";
  }
  if (!requested) return hasPayPalKeys ? "authorization" : "mock";
  if (requested !== "mock" && !hasPayPalKeys) {
    console.warn(`[config] PAYMENT_MODE=${requested} needs PAYPAL_CLIENT_ID/SECRET; falling back to mock.`);
    return "mock";
  }
  if (requested === "vault") {
    console.warn("[config] PAYMENT_MODE=vault is not implemented yet; using authorization.");
    return "authorization";
  }
  return requested;
}

export const config = {
  port: Number(env("PORT") ?? 3000),
  /** Absolute base URL for PayPal return links; derived from the request when unset. */
  publicUrl: env("PUBLIC_URL")?.replace(/\/$/, ""),
  /** Set by Render on every web service (https://<name>.onrender.com); fallback public URL for webhook registration. */
  renderExternalUrl: env("RENDER_EXTERNAL_URL")?.replace(/\/$/, ""),
  /** Optional override: the PayPal webhook id to verify events against. Otherwise found or created at startup. */
  paypalWebhookId: env("PAYPAL_WEBHOOK_ID"),
  production: env("NODE_ENV") === "production",

  aiProvider: (env("AI_PROVIDER") === "groq" ? "groq" : "google") as "google" | "groq",
  aiModel: env("AI_MODEL"),
  geminiApiKey: env("GEMINI_API_KEY"),
  groqApiKey: env("GROQ_API_KEY"),

  paypalClientId: env("PAYPAL_CLIENT_ID"),
  paypalClientSecret: env("PAYPAL_CLIENT_SECRET"),
  paypalEnv: (env("PAYPAL_ENV") ?? "sandbox") as "sandbox" | "live",
  paymentMode: paymentMode(),

  channel3ApiKey: env("CHANNEL3_API_KEY"),
  productSource: (env("PRODUCT_SOURCE") ?? (env("CHANNEL3_API_KEY") ? "channel3" : "catalog")) as "channel3" | "catalog",
  demoInjection: env("DEMO_INJECTION") === "1" || env("DEMO_INJECTION") === "true",

  storeFile: env("STORE_FILE") ?? ".data/store.json",
};

export type AiProvider = "google" | "groq";
export interface AiModelSpec {
  provider: AiProvider;
  model: string;
}

/** Gemini free-tier flash models; each has its own quota (about 20 requests/day, 5/minute). */
export const GEMINI_FLASH_MODELS = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"] as const;
/** Groq models with separate quotas (openai/gpt-oss-120b: 200k tokens/day). */
export const GROQ_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"] as const;

/** "provider:model" or a bare model id (gemini-* is Google; ids with a "/" or gpt-oss/llama are Groq). */
export function parseModelSpec(raw: string, defaultProvider: AiProvider = config.aiProvider): AiModelSpec | null {
  const t = raw.trim();
  if (!t) return null;
  const m = /^(google|gemini|groq):(.+)$/i.exec(t);
  if (m) return { provider: m[1].toLowerCase() === "groq" ? "groq" : "google", model: m[2].trim() };
  if (/^gemini/i.test(t)) return { provider: "google", model: t };
  if (t.includes("/") || /gpt-oss|llama|qwen|kimi/i.test(t)) return { provider: "groq", model: t };
  return { provider: defaultProvider, model: t };
}

export const specLabel = (s: AiModelSpec) => `${s.provider}:${s.model}`;

/**
 * The ordered model chain for every AI call (chat and gift-list parsing).
 * - AI_MODEL with commas: exactly that chain ("gemini-3.6-flash,groq:openai/gpt-oss-20b").
 * - AI_MODEL single (or unset): that model, then the other Gemini flash models, then Groq gpt-oss-120b
 *   and gpt-oss-20b (a Groq primary puts the other Groq model first, then the Gemini models).
 *   AI_FALLBACK_MODEL (comma list) replaces that tail; AI_FALLBACK=off keeps only the primary.
 * Members whose provider has no API key are dropped (the primary is always kept).
 */
export function aiChain(env: Record<string, string | undefined> = process.env, keys = { google: Boolean(config.geminiApiKey), groq: Boolean(config.groqApiKey) }): AiModelSpec[] {
  const get = (k: string) => (env[k]?.trim() ? env[k]!.trim() : undefined);
  const provider: AiProvider = get("AI_PROVIDER") === "groq" ? "groq" : "google";
  const rawModel = get("AI_MODEL");
  const parts = (rawModel ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  let chain: AiModelSpec[];
  if (parts.length > 1) {
    chain = parts.map((p) => parseModelSpec(p, provider)!).filter(Boolean);
  } else {
    const primary: AiModelSpec = parts[0]
      ? (parseModelSpec(parts[0], provider) as AiModelSpec)
      : { provider, model: provider === "groq" ? GROQ_MODELS[0] : GEMINI_FLASH_MODELS[0] };
    let tail: AiModelSpec[];
    if (get("AI_FALLBACK") === "off") tail = [];
    else if (get("AI_FALLBACK_MODEL")) tail = get("AI_FALLBACK_MODEL")!.split(",").map((p) => parseModelSpec(p, "groq")!).filter(Boolean);
    else {
      const gemini = GEMINI_FLASH_MODELS.map((model) => ({ provider: "google" as const, model }));
      const groq = GROQ_MODELS.map((model) => ({ provider: "groq" as const, model }));
      tail = primary.provider === "groq" ? [...groq, ...gemini] : [...gemini, ...groq];
    }
    chain = [primary, ...tail];
  }
  const seen = new Set<string>();
  return chain.filter((s, i) => {
    const key = specLabel(s);
    if (seen.has(key)) return false;
    seen.add(key);
    return i === 0 || keys[s.provider];
  });
}

/** Model id of the first chain member (the one tried first). */
export function aiModelId(): string {
  return aiChain()[0].model;
}

/** "provider:model" of the first chain member; what the UI compares `ai_active` against. */
export function aiLabel(): string {
  return specLabel(aiChain()[0]);
}
