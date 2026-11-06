// PayPal webhooks -> ledger: registration, signature verification (fetch mocked), event mapping, idempotency.
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.STORE_FILE = `${process.env.TEMP ?? process.env.TMPDIR ?? "/tmp"}/allowance-test-wh-${process.pid}.json`;
  process.env.PAYMENT_MODE = "mock";
  process.env.PAYPAL_CLIENT_ID = "test-client";
  process.env.PAYPAL_CLIENT_SECRET = "test-secret";
  process.env.PUBLIC_URL = "https://ribbon-test.example.com";
  delete process.env.PAYPAL_WEBHOOK_ID;
});

import express from "express";
import { config } from "./config.ts";
import { handlePayPalWebhook, resetWebhookCache, resolveWebhookId, WEBHOOK_EVENT_TYPES, WEBHOOK_PATH, webhookUrl } from "./paypal/webhooks.ts";
import { paypalWebhookHandler } from "./routes.ts";
import { createMandate, recordPayPalWebhook, type PayPalWebhookEvent } from "./service.ts";
import { createSession, type Session } from "./store.ts";

// ------------------------------------------------------------------ fetch mock (PayPal REST)

const realFetch = globalThis.fetch;
let verification = "SUCCESS";
let listed: any[] = [];
const calls: { method: string; url: string; body: string | undefined }[] = [];

function paypalFetch(input: any, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (!url.startsWith("https://api-m.sandbox.paypal.com")) return realFetch(input, init);
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? init.body : undefined;
  calls.push({ method, url, body });
  const json = (status: number, data: unknown) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }));
  const path = new URL(url).pathname;
  if (path === "/v1/oauth2/token") return json(200, { access_token: "tok", expires_in: 32000 });
  if (path === "/v1/notifications/verify-webhook-signature") return json(200, { verification_status: verification });
  if (path === "/v1/notifications/webhooks" && method === "GET") return json(200, { webhooks: listed });
  if (path === "/v1/notifications/webhooks" && method === "POST") return json(201, { id: "WH-CREATED-1", url: JSON.parse(body!).url });
  return json(404, { name: "RESOURCE_NOT_FOUND" });
}

beforeAll(() => {
  vi.stubGlobal("fetch", vi.fn(paypalFetch));
});
afterAll(() => {
  vi.unstubAllGlobals();
});
beforeEach(() => {
  calls.length = 0;
  verification = "SUCCESS";
  listed = [];
  resetWebhookCache();
  config.paypalWebhookId = undefined;
});

const verifyCalls = () => calls.filter((c) => c.url.endsWith("/v1/notifications/verify-webhook-signature"));

// ------------------------------------------------------------------ fixtures

const SIGNED = {
  "paypal-transmission-id": "69cd13f0-d67a-11e5-baa3-778b53f4ae55",
  "paypal-transmission-time": "2026-11-06T10:00:00Z",
  "paypal-transmission-sig": "c2lnbmF0dXJl",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-1d93a270",
  "paypal-auth-algo": "SHA256withRSA",
};

let n = 0;
function shopped(): Session {
  const s = createSession();
  createMandate(s, {
    title: "Holiday gifts",
    per_purchase_approval_over: 45,
    recipients: [
      { name: "Mom", envelope: 60, interests: "gardening" },
      { name: "Dad", envelope: 50, interests: "coffee" },
    ],
  });
  const m = s.mandate!;
  m.status = "active";
  const k = ++n;
  m.paypal.order_id = `ORDER${k}AAAA`;
  m.paypal.authorization_id = `AUTH${k}BBBB`;
  const base = { mandate_id: m.id, items: [], total: 20, decision: "allow" as const, reasons: [], rationale: "", error: null, created_at: new Date().toISOString(), shipment: null };
  s.purchases.push(
    { ...base, id: `pur_mom${k}`, status: "charged", recipient_id: m.recipients[0].id, paypal: { order_id: m.paypal.order_id, capture_id: `CAP${k}MOM`, refund_id: null, approve_url: null } },
    { ...base, id: `pur_dad${k}`, status: "refunded", recipient_id: m.recipients[1].id, paypal: { order_id: m.paypal.order_id, capture_id: `CAP${k}DAD`, refund_id: `REF${k}DAD`, approve_url: null } },
  );
  return s;
}

const event = (id: string, event_type: string, resource: any): PayPalWebhookEvent => ({ id, event_type, resource_type: "x", resource });
const webhookRows = (s: Session) => s.ledger.filter((r) => r.action === "paypal.webhook");

// ------------------------------------------------------------------ tests

describe("webhook id: find or register", () => {
  it("derives the URL only from an https, non-local public URL", () => {
    expect(webhookUrl("https://allowance-cpp0.onrender.com")).toBe("https://allowance-cpp0.onrender.com/api/paypal/webhook");
    expect(webhookUrl("https://allowance-cpp0.onrender.com/")).toBe("https://allowance-cpp0.onrender.com/api/paypal/webhook");
    expect(webhookUrl("http://allowance-cpp0.onrender.com")).toBeNull();
    expect(webhookUrl("https://localhost:3203")).toBeNull();
    expect(webhookUrl("")).toBeNull();
  });

  it("creates the webhook for the four event types when none matches, then caches the id", async () => {
    listed = [{ id: "WH-OTHER", url: "https://someone-else.example.com/hook", event_types: [{ name: "*" }] }];
    expect(await resolveWebhookId()).toBe("WH-CREATED-1");
    const create = calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/notifications/webhooks"))!;
    expect(JSON.parse(create.body!)).toEqual({
      url: "https://ribbon-test.example.com/api/paypal/webhook",
      event_types: WEBHOOK_EVENT_TYPES.map((name) => ({ name })),
    });
    calls.length = 0;
    expect(await resolveWebhookId()).toBe("WH-CREATED-1");
    expect(calls).toHaveLength(0);
  });

  it("reuses an existing webhook for our URL", async () => {
    listed = [{ id: "WH-EXISTING", url: "https://ribbon-test.example.com/api/paypal/webhook", event_types: WEBHOOK_EVENT_TYPES.map((name) => ({ name })) }];
    expect(await resolveWebhookId()).toBe("WH-EXISTING");
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/v1/notifications/webhooks"))).toBe(false);
  });

  it("PAYPAL_WEBHOOK_ID overrides discovery", async () => {
    config.paypalWebhookId = "WH-FROM-ENV";
    expect(await resolveWebhookId()).toBe("WH-FROM-ENV");
    expect(calls).toHaveLength(0);
  });
});

describe("verification", () => {
  it("rejects an unsigned event with 400 without calling PayPal", async () => {
    const s = shopped();
    const raw = JSON.stringify(event("WH-UNSIGNED", "PAYMENT.CAPTURE.COMPLETED", { id: `CAP${n}MOM`, status: "COMPLETED" }));
    const out = await handlePayPalWebhook({ headers: {}, rawBody: raw }, (e) => recordPayPalWebhook(e as PayPalWebhookEvent));
    expect(out.status).toBe(400);
    expect(String(out.body.error)).toMatch(/Unsigned/);
    expect(verifyCalls()).toHaveLength(0);
    expect(webhookRows(s)).toHaveLength(0);
  });

  it("rejects with 400 when PayPal answers FAILURE, and writes nothing", async () => {
    verification = "FAILURE";
    config.paypalWebhookId = "WH-1";
    const s = shopped();
    const raw = JSON.stringify(event("WH-FORGED", "PAYMENT.CAPTURE.COMPLETED", { id: `CAP${n}MOM`, status: "COMPLETED" }));
    const out = await handlePayPalWebhook({ headers: SIGNED, rawBody: raw }, (e) => recordPayPalWebhook(e as PayPalWebhookEvent));
    expect(out.status).toBe(400);
    expect(verifyCalls()).toHaveLength(1);
    expect(webhookRows(s)).toHaveLength(0);
  });

  it("sends the headers, the webhook id and the raw event byte for byte", async () => {
    config.paypalWebhookId = "WH-1";
    const s = shopped();
    // Spacing and "20.00" as written by PayPal must survive (no parse + re-stringify).
    const raw = `{ "id": "WH-RAW-1", "event_type": "PAYMENT.CAPTURE.COMPLETED", "resource": { "id": "CAP${n}MOM", "status": "COMPLETED", "amount": { "value": 20.00 } } }`;
    const out = await handlePayPalWebhook({ headers: SIGNED, rawBody: Buffer.from(raw) }, (e) => recordPayPalWebhook(e as PayPalWebhookEvent));
    expect(out.status).toBe(200);
    const sent = verifyCalls()[0].body!;
    expect(sent.endsWith(`"webhook_event":${raw}}`)).toBe(true);
    const parsed = JSON.parse(sent);
    expect(parsed).toMatchObject({
      auth_algo: "SHA256withRSA",
      cert_url: SIGNED["paypal-cert-url"],
      transmission_id: SIGNED["paypal-transmission-id"],
      transmission_sig: SIGNED["paypal-transmission-sig"],
      transmission_time: SIGNED["paypal-transmission-time"],
      webhook_id: "WH-1",
    });
    expect(webhookRows(s)).toHaveLength(1);
  });
});

describe("event -> ledger mapping", () => {
  it("capture completed: one paypal row on the purchase, balances unchanged", () => {
    const s = shopped();
    const before = { spent: s.mandate!.spent, refunded: s.mandate!.refunded, statuses: s.purchases.map((p) => p.status) };
    const out = recordPayPalWebhook(event("WH-C1", "PAYMENT.CAPTURE.COMPLETED", { id: `CAP${n}MOM`, status: "COMPLETED" }));
    expect(out).toMatchObject({ matched: true, duplicate: false, session_id: s.id });
    const [row] = webhookRows(s);
    expect(row).toMatchObject({
      actor: "paypal",
      action: "paypal.webhook",
      summary: `PayPal confirmed: capture CAP${n}MOM COMPLETED for Mom (webhook PAYMENT.CAPTURE.COMPLETED)`,
      paypal_id: `CAP${n}MOM`,
      purchase_id: `pur_mom${n}`,
      recipient_id: s.mandate!.recipients[0].id,
      amount: null,
    });
    expect({ spent: s.mandate!.spent, refunded: s.mandate!.refunded, statuses: s.purchases.map((p) => p.status) }).toEqual(before);
  });

  it("is idempotent by event id", () => {
    const s = shopped();
    const e = event("WH-DUP", "PAYMENT.CAPTURE.COMPLETED", { id: `CAP${n}MOM`, status: "COMPLETED" });
    recordPayPalWebhook(e);
    const again = recordPayPalWebhook(e);
    expect(again).toMatchObject({ matched: true, duplicate: true });
    expect(webhookRows(s)).toHaveLength(1);
  });

  it("matches a capture by invoice_id when the capture id is not stored yet", () => {
    const s = shopped();
    s.purchases[0].paypal.capture_id = null; // webhook raced ahead of the capture response
    recordPayPalWebhook(event("WH-INV", "PAYMENT.CAPTURE.COMPLETED", { id: "CAPNEW123", status: "COMPLETED", invoice_id: `pur_mom${n}` }));
    expect(webhookRows(s)[0]).toMatchObject({ purchase_id: `pur_mom${n}`, paypal_id: "CAPNEW123" });
  });

  it("refund: by refund id, and by the capture in its up link", () => {
    const s = shopped();
    recordPayPalWebhook(event("WH-R1", "PAYMENT.CAPTURE.REFUNDED", { id: `REF${n}DAD`, status: "COMPLETED" }));
    recordPayPalWebhook(
      event("WH-R2", "PAYMENT.CAPTURE.REFUNDED", {
        id: "REFUNKNOWN",
        status: "COMPLETED",
        links: [{ rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/CAP${n}MOM` }],
      }),
    );
    const rows = webhookRows(s);
    expect(rows[0]).toMatchObject({ summary: `PayPal confirmed: refund REF${n}DAD COMPLETED for Dad (webhook PAYMENT.CAPTURE.REFUNDED)`, purchase_id: `pur_dad${n}` });
    expect(rows[1]).toMatchObject({ purchase_id: `pur_mom${n}`, paypal_id: "REFUNKNOWN" });
  });

  it("authorization voided and order approved map to the gift list", () => {
    const s = shopped();
    recordPayPalWebhook(event("WH-V", "PAYMENT.AUTHORIZATION.VOIDED", { id: `AUTH${n}BBBB`, status: "VOIDED" }));
    recordPayPalWebhook(event("WH-O", "CHECKOUT.ORDER.APPROVED", { id: `ORDER${n}AAAA`, status: "APPROVED" }));
    const rows = webhookRows(s);
    expect(rows.map((r) => r.summary)).toEqual([
      `PayPal confirmed: authorization AUTH${n}BBBB VOIDED (webhook PAYMENT.AUTHORIZATION.VOIDED)`,
      `PayPal confirmed: order ORDER${n}AAAA APPROVED (webhook CHECKOUT.ORDER.APPROVED)`,
    ]);
    expect(rows.every((r) => r.purchase_id === null && r.actor === "paypal")).toBe(true);
  });

  it("unknown resources get a log line only", () => {
    const s = shopped();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const out = recordPayPalWebhook(event("WH-UNK", "PAYMENT.CAPTURE.COMPLETED", { id: "NOTOURS", status: "COMPLETED" }));
    expect(out.matched).toBe(false);
    expect(webhookRows(s)).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/WH-UNK.*NOTOURS.*not in any session/));
    log.mockRestore();
  });
});

describe("POST /api/paypal/webhook (express, raw body, no session)", () => {
  let server: ReturnType<ReturnType<typeof express>["listen"]>;
  let url = "";
  beforeAll(async () => {
    const app = express();
    app.post(WEBHOOK_PATH, express.raw({ type: "*/*", limit: "1mb" }), paypalWebhookHandler);
    app.use(express.json());
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${WEBHOOK_PATH}`;
  });
  afterAll(() => {
    server.close();
  });
  afterEach(() => {
    config.paypalWebhookId = undefined;
  });

  it("400 for an unsigned event, 200 and a ledger row for a verified one, no cookie set", async () => {
    config.paypalWebhookId = "WH-1";
    const s = shopped();
    const body = JSON.stringify(event("WH-HTTP-1", "PAYMENT.CAPTURE.COMPLETED", { id: `CAP${n}DAD`, status: "COMPLETED" }));
    const unsigned = await realFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(unsigned.status).toBe(400);
    expect(webhookRows(s)).toHaveLength(0);

    const signed = await realFetch(url, { method: "POST", headers: { "content-type": "application/json", ...SIGNED }, body });
    expect(signed.status).toBe(200);
    expect(await signed.json()).toEqual({ ok: true, event_id: "WH-HTTP-1", matched: true, duplicate: false });
    expect(signed.headers.get("set-cookie")).toBeNull();
    expect(webhookRows(s)[0].summary).toBe(`PayPal confirmed: capture CAP${n}DAD COMPLETED for Dad (webhook PAYMENT.CAPTURE.COMPLETED)`);
    expect(verifyCalls().at(-1)!.body!.endsWith(`"webhook_event":${body}}`)).toBe(true);
  });
});
