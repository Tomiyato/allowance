// PayPal webhooks: find or register this app's webhook, verify each delivery, hand it to the ledger.
//
// - Webhook id: PAYPAL_WEBHOOK_ID wins. Otherwise, at startup and lazily on the first delivery, list the
//   app's webhooks (GET /v1/notifications/webhooks) and pick the one whose url is
//   `${PUBLIC_URL or RENDER_EXTERNAL_URL}/api/paypal/webhook`; create it when missing
//   (POST /v1/notifications/webhooks). No https public URL (localhost): registration is skipped quietly.
// - Verification: POST /v1/notifications/verify-webhook-signature with the five paypal-* transmission
//   headers, the webhook id and the event exactly as received (raw body, not re-serialized).
//   Anything not verified answers 400.
// - Webhooks simulator events cannot be verified through that API (PayPal docs, "Webhooks simulator"), so
//   they are rejected with 400 too; only real sandbox events reach the ledger.
import { config } from "../config.ts";
import { paypal } from "./client.ts";
import { PaymentError } from "./rail.ts";

export const WEBHOOK_PATH = "/api/paypal/webhook";
export const WEBHOOK_EVENT_TYPES = [
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.AUTHORIZATION.VOIDED",
  "CHECKOUT.ORDER.APPROVED",
] as const;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The public https URL PayPal should deliver to, or null on localhost / without an https public URL. */
export function webhookUrl(base: string | undefined = config.publicUrl ?? config.renderExternalUrl): string | null {
  if (!base) return null;
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost") || host.endsWith(".local")) return null;
  return `${u.origin}${u.pathname.replace(/\/$/, "")}${WEBHOOK_PATH}`;
}

const sameUrl = (a: string, b: string) => a.replace(/\/$/, "").toLowerCase() === b.replace(/\/$/, "").toLowerCase();

let cachedId: string | null = null;
let inflight: Promise<string | null> | null = null;

/** Test hook: forget the cached webhook id. */
export function resetWebhookCache() {
  cachedId = null;
  inflight = null;
}

async function findOrCreate(url: string): Promise<string | null> {
  const list = await paypal<{ webhooks?: any[] }>({ method: "GET", path: "/v1/notifications/webhooks" });
  const existing = (list.webhooks ?? []).find((w) => typeof w?.url === "string" && sameUrl(w.url, url));
  if (existing?.id) {
    const have = new Set<string>((existing.event_types ?? []).map((e: any) => e?.name));
    const missing = WEBHOOK_EVENT_TYPES.filter((t) => !have.has(t) && !have.has("*"));
    if (missing.length) {
      try {
        await paypal({
          method: "PATCH",
          path: `/v1/notifications/webhooks/${existing.id}`,
          body: [{ op: "replace", path: "/event_types", value: [...new Set([...have, ...WEBHOOK_EVENT_TYPES])].map((name) => ({ name })) }],
        });
        console.log(`[paypal] webhook ${existing.id}: added event types ${missing.join(", ")}`);
      } catch (e) {
        console.warn(`[paypal] webhook ${existing.id}: could not add event types ${missing.join(", ")}: ${errMsg(e)}`);
      }
    }
    console.log(`[paypal] webhook ${existing.id} found for ${url}`);
    return existing.id;
  }
  try {
    const created = await paypal<{ id?: string }>({
      method: "POST",
      path: "/v1/notifications/webhooks",
      body: { url, event_types: WEBHOOK_EVENT_TYPES.map((name) => ({ name })) },
    });
    if (!created?.id) throw new PaymentError("Create webhook response has no id.", undefined, undefined, created);
    console.log(`[paypal] webhook ${created.id} registered for ${url}`);
    return created.id;
  } catch (e) {
    // Another instance registered it between our list and create: list again.
    if (e instanceof PaymentError && /WEBHOOK_URL_ALREADY_EXISTS/.test(e.message)) {
      const again = await paypal<{ webhooks?: any[] }>({ method: "GET", path: "/v1/notifications/webhooks" });
      const w = (again.webhooks ?? []).find((x) => typeof x?.url === "string" && sameUrl(x.url, url));
      if (w?.id) return w.id;
    }
    throw e;
  }
}

/**
 * The webhook id to verify against: PAYPAL_WEBHOOK_ID, else the cached id, else find or create it.
 * Null when it cannot be known (no PayPal keys, no https public URL, or PayPal refused); never throws.
 */
export async function resolveWebhookId(): Promise<string | null> {
  if (config.paypalWebhookId) return config.paypalWebhookId;
  if (cachedId) return cachedId;
  if (!config.paypalClientId || !config.paypalClientSecret) return null;
  const url = webhookUrl();
  if (!url) return null;
  inflight ??= findOrCreate(url)
    .then((id) => {
      cachedId = id;
      return id;
    })
    .catch((e) => {
      console.warn(`[paypal] webhook registration failed (will retry on the next delivery): ${errMsg(e)}`);
      return null;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Startup: register quietly in the background; logs once what it did or why it skipped. */
export function initPayPalWebhooks(): void {
  if (config.paypalWebhookId) {
    console.log("[paypal] webhook id from PAYPAL_WEBHOOK_ID");
    return;
  }
  if (!config.paypalClientId || !config.paypalClientSecret) return;
  if (!webhookUrl()) return; // localhost or no https public URL: PayPal cannot deliver here
  void resolveWebhookId();
}

// ---------------------------------------------------------------- verification

const HEADER_NAMES = {
  transmission_id: "paypal-transmission-id",
  transmission_time: "paypal-transmission-time",
  transmission_sig: "paypal-transmission-sig",
  cert_url: "paypal-cert-url",
  auth_algo: "paypal-auth-algo",
} as const;

export type WebhookHeaders = Record<keyof typeof HEADER_NAMES, string>;

type RawHeaders = Record<string, string | string[] | undefined>;

/** The five transmission headers, or null when any is missing. */
export function transmissionHeaders(headers: RawHeaders): WebhookHeaders | null {
  const out: Partial<WebhookHeaders> = {};
  for (const [key, name] of Object.entries(HEADER_NAMES) as [keyof WebhookHeaders, string][]) {
    const v = headers[name];
    const value = Array.isArray(v) ? v[0] : v;
    if (!value) return null;
    out[key] = value;
  }
  return out as WebhookHeaders;
}

/** Ask PayPal whether this delivery is genuine. The event goes back byte for byte as it arrived. */
export async function verifyWebhookSignature(h: WebhookHeaders, rawBody: string, webhookId: string): Promise<boolean> {
  const J = JSON.stringify;
  const rawJson =
    `{"auth_algo":${J(h.auth_algo)},"cert_url":${J(h.cert_url)},"transmission_id":${J(h.transmission_id)},` +
    `"transmission_sig":${J(h.transmission_sig)},"transmission_time":${J(h.transmission_time)},` +
    `"webhook_id":${J(webhookId)},"webhook_event":${rawBody}}`;
  const r = await paypal<{ verification_status?: string }>({ method: "POST", path: "/v1/notifications/verify-webhook-signature", rawJson });
  return r?.verification_status === "SUCCESS";
}

// ---------------------------------------------------------------- handler

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface ParsedEvent {
  id: string;
  event_type: string;
  resource?: any;
  [k: string]: unknown;
}

/**
 * Framework-free webhook handling: parse, check headers, verify with PayPal, then `record` it.
 * 400 for anything unverified or malformed; 502 when PayPal's verify call itself fails (PayPal retries).
 */
export async function handlePayPalWebhook(
  input: { headers: RawHeaders; rawBody: string | Buffer | undefined },
  record: (event: ParsedEvent) => unknown,
): Promise<WebhookResponse> {
  const raw = Buffer.isBuffer(input.rawBody) ? input.rawBody.toString("utf8") : (input.rawBody ?? "");
  const reject = (status: number, error: string): WebhookResponse => {
    console.warn(`[paypal] webhook rejected (${status}): ${error}`);
    return { status, body: { error } };
  };
  if (!raw.trim()) return reject(400, "Empty body");
  let event: ParsedEvent;
  try {
    event = JSON.parse(raw);
  } catch {
    return reject(400, "Body is not JSON");
  }
  if (!event || typeof event.id !== "string" || typeof event.event_type !== "string") return reject(400, "Not a PayPal webhook event");
  const h = transmissionHeaders(input.headers);
  if (!h) return reject(400, `Unsigned event ${event.id}: PayPal transmission headers are missing`);
  const webhookId = await resolveWebhookId();
  if (!webhookId) return reject(400, `Cannot verify ${event.id}: no PayPal webhook id (set PAYPAL_WEBHOOK_ID or an https PUBLIC_URL)`);
  let ok: boolean;
  try {
    ok = await verifyWebhookSignature(h, raw, webhookId);
  } catch (e) {
    return reject(502, `PayPal could not verify ${event.id}: ${errMsg(e)}`);
  }
  if (!ok) return reject(400, `Signature verification failed for ${event.id} (${event.event_type})`);
  const outcome = record(event) as { matched?: boolean; duplicate?: boolean } | undefined;
  // Session ids stay server-side; PayPal only needs a 2xx.
  return { status: 200, body: { ok: true, event_id: event.id, matched: !!outcome?.matched, duplicate: !!outcome?.duplicate } };
}
