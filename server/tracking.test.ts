// Shipment tracking after each capture (authorization rail, PayPal client mocked).
// Sandbox-verified 2026-11-06: Orders v2 track works for a capture from an AUTHORIZE order;
// trackers-batch is the fallback. A tracking failure never fails the purchase.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.STORE_FILE = `${process.env.TEMP ?? process.env.TMPDIR ?? "/tmp"}/allowance-test-tr-${process.pid}.json`;
  process.env.PAYMENT_MODE = "authorization";
  process.env.PAYPAL_CLIENT_ID = "test-client";
  process.env.PAYPAL_CLIENT_SECRET = "test-secret";
});

const paypal = vi.hoisted(() => vi.fn());
vi.mock("./paypal/client.ts", async (orig) => ({ ...(await orig<typeof import("./paypal/client.ts")>()), paypal }));

import type { Product } from "../shared/types.ts";
import { PaymentError } from "./paypal/rail.ts";
import { approvePurchase, createMandate, proposePurchase, refundPurchase } from "./service.ts";
import { createSession } from "./store.ts";

const BASE = "http://localhost:0";
const ORDER = "0JK73366XC201873M";
const AUTH = "5A8492897H628980B";

const product = (id: string, price: number): Product => ({
  id,
  title: `Garden gift ${id}`,
  description: "",
  price,
  currency: "USD",
  category: "garden",
  category_confidence: "high",
  merchant: "Test merchant",
  image_url: null,
  url: null,
  source: "catalog",
});

function giftList() {
  const s = createSession();
  createMandate(s, {
    title: "Holiday gifts",
    per_purchase_approval_over: 45,
    blocked_categories: ["electronics"],
    recipients: [
      { name: "Mom", envelope: 60, interests: "gardening" },
      { name: "Dad", envelope: 50, interests: "coffee" },
    ],
  });
  s.mandate!.status = "active";
  s.mandate!.paypal.order_id = ORDER;
  s.mandate!.paypal.authorization_id = AUTH;
  s.products.p1 = product("p1", 20);
  s.products.p2 = product("p2", 55);
  const [mom, dad] = s.mandate!.recipients;
  return { s, mom, dad };
}

/** Answers like the sandbox did: capture, then the order with its trackers. */
function sandboxLike(opts: { orderTrack?: "ok" | "fail"; batch?: "ok" | "fail" | "errors" } = {}) {
  paypal.mockImplementation(async (req: { path: string; body?: any }) => {
    if (req.path.endsWith("/capture")) return { id: "43R3365866516402T", status: "COMPLETED" };
    if (req.path.endsWith("/refund")) return { id: "REFUND1", status: "COMPLETED" };
    if (req.path === `/v2/checkout/orders/${ORDER}/track`) {
      if (opts.orderTrack === "fail") throw new PaymentError(`PayPal POST /v2/checkout/orders/${ORDER}/track failed (422 UNPROCESSABLE_ENTITY): nope`, 422);
      const id = `${req.body.capture_id}-${req.body.tracking_number}`;
      return { id: ORDER, purchase_units: [{ shipping: { trackers: [{ id, status: "SHIPPED" }] } }] };
    }
    if (req.path === "/v1/shipping/trackers-batch") {
      if (opts.batch === "fail") throw new PaymentError("PayPal POST /v1/shipping/trackers-batch failed (400 INVALID_REQUEST): bad", 400);
      if (opts.batch === "errors") return { tracker_identifiers: [], errors: [{ name: "INVALID_REQUEST", message: "bad tracker" }] };
      const t = req.body.trackers[0];
      return { tracker_identifiers: [{ transaction_id: t.transaction_id, tracking_number: t.tracking_number }], errors: [] };
    }
    throw new Error(`unexpected call ${req.path}`);
  });
}

describe("shipment tracking after a capture", () => {
  beforeEach(() => {
    paypal.mockReset();
  });

  it("registers a demo shipment on the PayPal order and logs paypal.tracking", async () => {
    sandboxLike();
    const { s, mom } = giftList();
    const p = await proposePurchase(s, [{ product_id: "p1", qty: 1 }], "she gardens", BASE, "agent", mom.id);
    expect(p.status).toBe("charged");
    const call = paypal.mock.calls.map((c) => c[0]).find((r) => r.path.endsWith("/track"));
    expect(call.body).toMatchObject({
      capture_id: "43R3365866516402T",
      carrier: "OTHER",
      carrier_name_other: "Ribbon demo shipping",
      notify_payer: false,
      items: [{ name: "Garden gift p1", quantity: "1" }],
    });
    expect(call.body.tracking_number).toMatch(/^RIB[0-9A-Z]{10}$/);
    expect(p.shipment).toMatchObject({ carrier: "OTHER", carrier_name: "Ribbon demo shipping", status: "SHIPPED", tracking_number: call.body.tracking_number });
    expect(p.shipment!.tracker_id).toBe(`43R3365866516402T-${call.body.tracking_number}`);
    const row = s.ledger.find((r) => r.action === "paypal.tracking")!;
    expect(row.summary).toBe(`Shipped Mom's gift: tracking ${call.body.tracking_number} added to the PayPal order (Ribbon demo shipping)`);
    expect(row).toMatchObject({ actor: "paypal", paypal_id: p.shipment!.tracker_id, purchase_id: p.id, recipient_id: mom.id });
    // The tracking row comes right after the capture row.
    const actions = s.ledger.map((r) => r.action);
    expect(actions.indexOf("paypal.tracking")).toBe(actions.indexOf("paypal.capture") + 1);
  });

  it("falls back to trackers-batch when the Orders track call fails", async () => {
    sandboxLike({ orderTrack: "fail" });
    const { s, dad } = giftList();
    const p = await proposePurchase(s, [{ product_id: "p1", qty: 1 }], "", BASE, "agent", dad.id);
    expect(p.shipment?.status).toBe("SHIPPED");
    const batch = paypal.mock.calls.map((c) => c[0]).find((r) => r.path === "/v1/shipping/trackers-batch");
    expect(batch.body.trackers[0]).toMatchObject({ transaction_id: "43R3365866516402T", status: "SHIPPED", carrier: "OTHER", notify_buyer: false });
    expect(s.ledger.find((r) => r.action === "paypal.tracking")!.summary).toMatch(/^Shipped Dad's gift: tracking RIB\w+ added to the PayPal capture/);
  });

  it.each(["fail", "errors"] as const)("never fails the purchase when tracking fails (batch %s)", async (batch) => {
    sandboxLike({ orderTrack: "fail", batch });
    const { s, mom } = giftList();
    const p = await proposePurchase(s, [{ product_id: "p1", qty: 1 }], "", BASE, "agent", mom.id);
    expect(p.status).toBe("charged");
    expect(p.paypal.capture_id).toBe("43R3365866516402T");
    expect(p.shipment).toBeNull();
    expect(s.mandate!.spent).toBe(20);
    const row = s.ledger.find((r) => r.action === "paypal.tracking_failed")!;
    expect(row.summary).toMatch(/^PayPal tracking failed: /);
    expect(row.purchase_id).toBe(p.id);
    expect(s.ledger.some((r) => r.action === "paypal.tracking")).toBe(false);
  });

  it("ships a gift after the user approves it, and keeps the shipment on refund", async () => {
    sandboxLike();
    const { s, mom } = giftList();
    const p = await proposePurchase(s, [{ product_id: "p2", qty: 1 }], "", BASE, "agent", mom.id);
    expect(p.status).toBe("pending_approval");
    expect(p.shipment).toBeNull();
    await approvePurchase(s, p.id, BASE);
    expect(p.status).toBe("charged");
    expect(p.shipment?.tracking_number).toMatch(/^RIB/);
    const tn = p.shipment!.tracking_number;
    await refundPurchase(s, p.id, "changed my mind", "user");
    expect(p.status).toBe("refunded");
    expect(p.shipment?.tracking_number).toBe(tn);
    expect(paypal.mock.calls.filter((c) => c[0].path.endsWith("/track"))).toHaveLength(1);
  });

  it("does not track blocked purchases", async () => {
    sandboxLike();
    const { s } = giftList();
    const p = await proposePurchase(s, [{ product_id: "p1", qty: 1 }], "", BASE, "agent", null);
    expect(p.status).toBe("blocked");
    expect(paypal).not.toHaveBeenCalled();
    expect(p.shipment).toBeNull();
  });
});
