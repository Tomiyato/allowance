// PayPal REST client: OAuth client-credentials token cache + JSON requests with idempotency.
// Verified against the PayPal sandbox on 2026-11-04 (see docs/research/paypal-sandbox-results.md).
import { randomUUID } from "node:crypto";
import { config } from "../config.ts";
import { PaymentError } from "./rail.ts";

const BASE = config.paypalEnv === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

let cached: { token: string; expiresAt: number } | null = null;
let inflight: Promise<string> | null = null;

async function fetchToken(): Promise<string> {
  if (!config.paypalClientId || !config.paypalClientSecret) {
    throw new PaymentError("PayPal credentials are not configured (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET).");
  }
  const basic = Buffer.from(`${config.paypalClientId}:${config.paypalClientSecret}`).toString("base64");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new PaymentError(`PayPal OAuth failed (${res.status}): ${body.error_description ?? body.error ?? "no token"}`, res.status);
  }
  // Refresh a minute early; sandbox tokens last hours (expires_in is seconds).
  cached = { token: body.access_token, expiresAt: Date.now() + (Number(body.expires_in ?? 3600) - 60) * 1000 };
  return cached.token;
}

export async function accessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  inflight ??= fetchToken().finally(() => {
    inflight = null;
  });
  return inflight;
}

export interface PayPalRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  /** A pre-serialized JSON body, sent byte for byte (webhook verification embeds the raw event). Wins over body. */
  rawJson?: string;
  /** Stable key for retries of the same logical operation (PayPal-Request-Id). */
  requestId?: string;
}

export async function paypal<T = any>(req: PayPalRequest): Promise<T> {
  const attempt = async (retryAuth: boolean): Promise<T> => {
    const token = await accessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      Prefer: "return=representation",
    };
    if (req.method !== "GET") headers["PayPal-Request-Id"] = req.requestId ?? randomUUID();
    const res = await fetch(`${BASE}${req.path}`, {
      method: req.method,
      headers,
      body: req.rawJson ?? (req.body === undefined ? undefined : JSON.stringify(req.body)),
    });
    if (res.status === 401 && retryAuth) {
      cached = null;
      return attempt(false);
    }
    const text = await res.text();
    const json: any = text ? safeJson(text) : {};
    if (!res.ok) {
      const issue = json?.details?.[0]?.issue ?? json?.name ?? "ERROR";
      const desc = json?.details?.[0]?.description ?? json?.message ?? text.slice(0, 200);
      throw new PaymentError(`PayPal ${req.method} ${req.path} failed (${res.status} ${issue}): ${desc}`, res.status, json?.debug_id, json);
    }
    return json as T;
  };
  return attempt(true);
}

function safeJson(t: string) {
  try {
    return JSON.parse(t);
  } catch {
    return { raw: t };
  }
}

/** What the buyer sees on PayPal pages, statements and refund emails. */
export const PAYPAL_BRAND_NAME = "Ribbon";
/** Card/bank statement descriptor; PayPal Payments v2 caps soft_descriptor at 22 characters. */
export const PAYPAL_SOFT_DESCRIPTOR = "RIBBON GIFTS";
export const PAYPAL_REFUND_NOTE = "Returned via Ribbon";

export const money = (amount: number) => ({ currency_code: "USD", value: amount.toFixed(2) });

/** Buyer approval link from an order response: `payer-action` when payment_source is sent, else `approve`. */
export function approveLink(order: any): string {
  const link = (order?.links ?? []).find((l: any) => l.rel === "payer-action" || l.rel === "approve");
  if (!link?.href) throw new PaymentError("PayPal order response has no approve/payer-action link.", undefined, undefined, order);
  return link.href;
}
