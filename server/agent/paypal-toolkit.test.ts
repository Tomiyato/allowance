// PayPal Agent Toolkit integration: only allowlisted read-only toolkit tools may reach the model, they keep
// the toolkit's own schema under AI SDK v7, and every lookup is scoped to the session's own PayPal ids.
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.STORE_FILE = `${process.env.TEMP ?? process.env.TMPDIR ?? "/tmp"}/allowance-test-pptk-${process.pid}.json`;
  process.env.PAYMENT_MODE = "mock";
  process.env.PRODUCT_SOURCE = "catalog";
});

import { ALL_TOOLS_ENABLED, PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";
import { asSchema } from "ai";
import type { PayPalCheckOutput, Purchase } from "../../shared/types.ts";
import { createMandate } from "../service.ts";
import { createSession, type Session } from "../store.ts";
import {
  buildPayPalToolkitTools,
  PAYPAL_TOOLKIT_ALLOWLIST,
  selectReadOnly,
  sessionPayPalIds,
  summarize,
  TOOLKIT_ACTIONS,
  type RawToolkitTools,
} from "./paypal-toolkit.ts";
import { agentInstructions } from "./prompt.ts";
import { buildTools } from "./tools.ts";

const BASE = "http://localhost:0";
const opts = { toolCallId: "call_1", messages: [], context: undefined } as never;

/** Real toolkit tools; constructing the toolkit makes no network call (the token is fetched on first execute). */
function realToolkitTools(actions: Record<string, Record<string, boolean>>): RawToolkitTools {
  const tk = new PayPalAgentToolkit({ clientId: "test-id", clientSecret: "test-secret", configuration: { actions, context: { sandbox: true } } });
  return tk.getTools() as unknown as RawToolkitTools;
}

/** Tools that move money or change PayPal state; none of them may ever be registered for the model. */
const MONEY_MOVING = [
  "create_order",
  "pay_order",
  "create_refund",
  "create_invoice",
  "send_invoice",
  "cancel_sent_invoice",
  "record_payment_for_invoice",
  "record_refund_for_invoice",
  "create_subscription",
  "cancel_subscription",
  "update_subscription",
  "create_subscription_plan",
  "update_plan",
  "accept_dispute_claim",
  "create_shipment_tracking",
  "update_shipment_tracking",
  "create_product",
];

const ORDER_ID = "5O190127TN364715T";
const AUTH_ID = "0VF52814937998046";
const CAP_MOM = "3C679366HH908993F";
const CAP_SAM = "7TK53561YB803214S";
const REFUND_SAM = "1JU08902781691411";

function purchase(id: string, recipient_id: string, title: string, total: number, paypal: Partial<Purchase["paypal"]>, status: Purchase["status"]): Purchase {
  return {
    id,
    mandate_id: "",
    items: [{ product_id: `prd_${id}`, title, price: total, qty: 1, category: "gifts", merchant: "Shop", image_url: null, url: null }],
    total,
    status,
    decision: "allow",
    reasons: [],
    rationale: "",
    paypal: { order_id: ORDER_ID, capture_id: null, refund_id: null, approve_url: null, ...paypal },
    error: null,
    created_at: new Date().toISOString(),
    recipient_id,
  };
}

/** A gift list whose PayPal ids look like a real authorization-mode run: one order, Mom bought, Sam refunded. */
function giftList(): { s: Session; mom: string; sam: string } {
  const s = createSession();
  createMandate(s, {
    title: "Holiday gifts",
    budget_total: 90,
    per_purchase_approval_over: 45,
    allowed_categories: ["gifts"],
    blocked_categories: [],
    max_quantity_per_item: 2,
    recipients: [
      { name: "Mom", envelope: 60, interests: "gardening" },
      { name: "Sam", envelope: 30, interests: "soccer" },
    ],
  });
  const m = s.mandate!;
  m.status = "active";
  m.paypal = { ...m.paypal, mode: "authorization", order_id: ORDER_ID, authorization_id: AUTH_ID };
  const [mom, sam] = m.recipients.map((r) => r.id);
  s.purchases.push(
    { ...purchase("pur_mom", mom, "Garden kneeler", 48, { capture_id: CAP_MOM }, "charged"), mandate_id: m.id },
    { ...purchase("pur_sam", sam, "Shin guards", 22, { capture_id: CAP_SAM, refund_id: REFUND_SAM }, "refunded"), mandate_id: m.id },
  );
  return { s, mom, sam };
}

const ORDER_JSON = {
  id: ORDER_ID,
  intent: "AUTHORIZE",
  status: "COMPLETED",
  create_time: "2026-11-06T10:00:00Z",
  purchase_units: [
    {
      amount: { currency_code: "USD", value: "90.00" },
      payments: {
        authorizations: [{ id: AUTH_ID, status: "PARTIALLY_CAPTURED", amount: { currency_code: "USD", value: "90.00" }, expiration_time: "2026-12-05T10:00:00Z" }],
        captures: [
          { id: CAP_MOM, status: "COMPLETED", amount: { currency_code: "USD", value: "48.00" }, invoice_id: "pur_mom", create_time: "2026-11-06T10:01:00Z" },
          { id: CAP_SAM, status: "REFUNDED", amount: { currency_code: "USD", value: "22.00" }, invoice_id: "pur_sam" },
        ],
        refunds: [
          {
            id: REFUND_SAM,
            status: "COMPLETED",
            amount: { currency_code: "USD", value: "22.00" },
            invoice_id: "pur_sam-r",
            links: [{ rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/${CAP_SAM}` }],
          },
        ],
      },
    },
  ],
};

describe("PayPal Agent Toolkit allowlist", () => {
  it("our toolkit configuration yields exactly the allowlisted tools", () => {
    const keys = Object.keys(realToolkitTools(TOOLKIT_ACTIONS)).sort();
    expect(keys).toEqual([...PAYPAL_TOOLKIT_ALLOWLIST].sort());
  });

  it("registers no non-allowlisted toolkit tool, even when the toolkit is handed every action", () => {
    const all = realToolkitTools(ALL_TOOLS_ENABLED);
    const toolkitNames = Object.keys(all);
    expect(toolkitNames.length).toBeGreaterThan(40); // the test is not vacuous: the toolkit really offers them
    expect(toolkitNames).toEqual(expect.arrayContaining(MONEY_MOVING));

    const { s } = giftList();
    const registered = Object.keys(buildTools({ session: s, baseUrl: BASE, paypalToolkit: all as never }));
    const leaked = registered.filter((n) => toolkitNames.includes(n) && !(PAYPAL_TOOLKIT_ALLOWLIST as readonly string[]).includes(n));
    expect(leaked).toEqual([]);
    for (const n of MONEY_MOVING) expect(registered).not.toContain(n);
    expect(registered).not.toContain("list_transactions");
    expect(registered).toEqual(expect.arrayContaining([...PAYPAL_TOOLKIT_ALLOWLIST]));
    expect(Object.keys(selectReadOnly(all)).sort()).toEqual([...PAYPAL_TOOLKIT_ALLOWLIST].sort());
  });

  it("without the toolkit (mock rail, no credentials) the agent has no PayPal lookup tools", () => {
    const { s } = giftList();
    const names = Object.keys(buildTools({ session: s, baseUrl: BASE }));
    for (const n of PAYPAL_TOOLKIT_ALLOWLIST) expect(names).not.toContain(n);
    expect(names).toContain("buy_gift_plan");
  });

  it("each wrapped tool keeps the toolkit's own input schema under AI SDK v7 (not the empty schema of a raw v4 tool)", async () => {
    const { s } = giftList();
    const tools = buildPayPalToolkitTools(s, realToolkitTools(TOOLKIT_ACTIONS) as never);
    const order: any = await asSchema(tools.get_order.inputSchema).jsonSchema;
    expect(order.required).toEqual(["id"]);
    expect(order.properties.id.pattern).toBe("^[A-Z0-9]{17,32}$");
    const refund: any = await asSchema(tools.get_refund.inputSchema).jsonSchema;
    expect(refund.required).toEqual(["refund_id"]);
    const tracking: any = await asSchema(tools.get_shipment_tracking.inputSchema).jsonSchema;
    expect(Object.keys(tracking.properties).sort()).toEqual(["order_id", "transaction_id"]);
    expect(tools.get_order.description).toMatch(/Read-only.*PayPal Agent Toolkit/);
    expect(tools.get_order.description).toContain("Retrieves the order details from PayPal"); // the toolkit's own text
  });
});

describe("PayPal Agent Toolkit lookups", () => {
  const fake = (result: unknown) => {
    const execute = vi.fn(async () => JSON.stringify(result));
    const raw = Object.fromEntries(PAYPAL_TOOLKIT_ALLOWLIST.map((n) => [n, { description: n, parameters: realToolkitTools(TOOLKIT_ACTIONS)[n].parameters, execute }]));
    return { raw, execute };
  };

  it("knows the session's own PayPal ids", () => {
    const { s } = giftList();
    expect([...sessionPayPalIds(s)].sort()).toEqual([ORDER_ID, AUTH_ID, CAP_MOM, CAP_SAM, REFUND_SAM].sort());
  });

  it("refuses ids from outside this gift list without calling PayPal", async () => {
    const { s } = giftList();
    const { raw, execute } = fake(ORDER_JSON);
    const tools = buildPayPalToolkitTools(s, raw as never);
    const out = (await tools.get_order.execute!({ id: "9XX99999XX9999999" }, opts)) as PayPalCheckOutput;
    expect(out).toMatchObject({ ok: false, source: "paypal_agent_toolkit", tool: "get_order", records: [] });
    expect(out.error).toMatch(/not a PayPal id from this gift list/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("get_order returns PayPal's records matched to each person through invoice_id", async () => {
    const { s, mom, sam } = giftList();
    const { raw, execute } = fake(ORDER_JSON);
    const tools = buildPayPalToolkitTools(s, raw as never);
    const out = (await tools.get_order.execute!({ id: ORDER_ID }, opts)) as PayPalCheckOutput;
    expect(execute).toHaveBeenCalledWith({ id: ORDER_ID });
    expect(out.ok).toBe(true);
    expect(out.records.map((r) => [r.kind, r.id, r.status, r.amount, r.recipient_name])).toEqual([
      ["order", ORDER_ID, "COMPLETED", 90, null],
      ["authorization", AUTH_ID, "PARTIALLY_CAPTURED", 90, null],
      ["capture", CAP_MOM, "COMPLETED", 48, "Mom"],
      ["capture", CAP_SAM, "REFUNDED", 22, "Sam"],
      ["refund", REFUND_SAM, "COMPLETED", 22, "Sam"],
    ]);
    expect(out.records[2]).toMatchObject({ recipient_id: mom, purchase_id: "pur_mom", gift: "Garden kneeler" });
    expect(out.records[4]).toMatchObject({ recipient_id: sam, note: `refund of capture ${CAP_SAM}` });

    const model: any = await tools.get_order.toModelOutput!({ toolCallId: "c", input: { id: ORDER_ID }, output: out });
    expect(model.type).toBe("json");
    expect(model.value.source).toMatch(/PayPal's own records via the PayPal Agent Toolkit/);
    expect(model.value.records[2]).toEqual({ kind: "capture", id: CAP_MOM, status: "COMPLETED", amount: 48, for: "Mom", gift: "Garden kneeler", purchase_id: "pur_mom", time: "2026-11-06T10:01:00Z" });
  });

  it("get_refund maps the refund to its person and passes PayPal errors through", async () => {
    const { s } = giftList();
    const refund = { id: REFUND_SAM, status: "COMPLETED", amount: { currency_code: "USD", value: "22.00" }, invoice_id: "pur_sam-r", links: [{ rel: "up", href: `https://x/v2/payments/captures/${CAP_SAM}` }] };
    const ok = (await buildPayPalToolkitTools(s, fake(refund).raw as never).get_refund.execute!({ refund_id: REFUND_SAM }, opts)) as PayPalCheckOutput;
    expect(ok.records).toEqual([expect.objectContaining({ kind: "refund", status: "COMPLETED", amount: 22, recipient_name: "Sam", note: `refund of capture ${CAP_SAM}` })]);

    const err = { ok: false, status: 404, code: "PAYPAL_API_HTTP_ERROR", message: "The specified resource does not exist." };
    const bad = (await buildPayPalToolkitTools(s, fake(err).raw as never).get_refund.execute!({ refund_id: REFUND_SAM }, opts)) as PayPalCheckOutput;
    expect(bad).toMatchObject({ ok: false, records: [], error: "PayPal 404: The specified resource does not exist." });
  });

  it("get_shipment_tracking reads trackers by capture id and asks for one when given the shared list order", async () => {
    const { s } = giftList();
    // Shape seen live from the sandbox (v1 trackers report last_updated_time as epoch milliseconds).
    const trackers = { trackers: [{ transaction_id: CAP_MOM, tracking_number: "RIB123", status: "SHIPPED", carrier: "OTHER", carrier_name_other: "Ribbon demo shipping", last_updated_time: "1793937376664" }], links: [] };
    const { raw, execute } = fake(trackers);
    const tools = buildPayPalToolkitTools(s, raw as never);
    const out = (await tools.get_shipment_tracking.execute!({ transaction_id: CAP_MOM }, opts)) as PayPalCheckOutput;
    expect(out.records).toEqual([
      expect.objectContaining({ kind: "tracker", id: "RIB123", status: "SHIPPED", recipient_name: "Mom", note: `Ribbon demo shipping, capture ${CAP_MOM}`, time: new Date(1793937376664).toISOString() }),
    ]);
    const viaOrder = (await tools.get_shipment_tracking.execute!({ order_id: ORDER_ID }, opts)) as PayPalCheckOutput;
    expect(viaOrder.error).toMatch(/capture id as transaction_id/);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("summarize maps Orders v2 trackers to the capture in their id", () => {
    const { s } = giftList();
    const order = { ...ORDER_JSON, purchase_units: [{ ...ORDER_JSON.purchase_units[0], shipping: { trackers: [{ id: `${CAP_MOM}-RIB123`, status: "SHIPPED" }] } }] };
    const t = summarize("get_order", order, s).find((r) => r.kind === "tracker");
    expect(t).toMatchObject({ recipient_name: "Mom", note: "tracking RIB123" });
  });
});

describe("prompt with PayPal lookups", () => {
  it("names the list's PayPal order, the gifts' PayPal ids and the read-only rule only when lookups are on", () => {
    const { s } = giftList();
    const list = { recipients: [], purchases: s.purchases };
    const statuses = s.mandate!.recipients.map((r) => ({
      recipient: r,
      spent: 0,
      remaining: r.envelope,
      state: "to_buy" as const,
      purchase_ids: s.purchases.filter((p) => p.recipient_id === r.id).map((p) => p.id),
    }));
    const on = agentInstructions(s.mandate, 68, new Date(), { ...list, recipients: statuses, paypalLookups: true });
    expect(on).toContain(`PayPal order for the whole list: ${ORDER_ID}`);
    expect(on).toContain(`PayPal capture ${CAP_MOM}`);
    expect(on).toContain(`PayPal refund ${REFUND_SAM}`);
    expect(on).toMatch(/get_order with the list's PayPal order id/);
    expect(on).toMatch(/never use them to buy, pay or refund/);

    const off = agentInstructions(s.mandate, 68, new Date(), { ...list, recipients: statuses });
    expect(off).not.toContain(ORDER_ID);
    expect(off).not.toContain("get_order");
  });
});
