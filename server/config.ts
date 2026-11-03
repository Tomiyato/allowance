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
  production: env("NODE_ENV") === "production",

  aiProvider: (env("AI_PROVIDER") ?? "google") as "google" | "groq",
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

export function aiModelId(): string {
  if (config.aiModel) return config.aiModel;
  return config.aiProvider === "groq" ? "openai/gpt-oss-120b" : "gemini-3.8-flash";
}

export function aiLabel(): string {
  return `${config.aiProvider}:${aiModelId()}`;
}
