// per_purchase rail contract: the buyer's PayPal approval link lives in purchase.paypal.approve_url,
// not in purchase.error.
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.STORE_FILE = `${process.env.TEMP ?? process.env.TMPDIR ?? "/tmp"}/allowance-test-pp-${process.pid}.json`;
});

const APPROVE = "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T";

vi.mock("./paypal/index.ts", () => {
  class PaymentError extends Error {}
  return {
    PaymentError,
    rail: {
      mode: "per_purchase",
      authorizeMandate: async () => ({ approveUrl: "/paypal/return?token=NONE", paypal: {} }),
      finalize: async () => ({}),
      charge: async () => ({ status: "payer_action_required", order_id: "5O190127TN364715T", approveUrl: APPROVE }),
      completeCharge: async () => ({ capture_id: "2GG279541U471931P" }),
      refund: async () => ({ refund_id: "1JU08902781691411" }),
      revoke: async () => ({ paypal_id: null }),
    },
  };
});

import { completePurchaseApproval, createMandate, proposePurchase } from "./service.ts";
import { createSession } from "./store.ts";

describe("per_purchase rail: approve_url", () => {
  it("stores the PayPal approval link in paypal.approve_url and keeps error empty", async () => {
    const s = createSession();
    createMandate(s, {
      title: "Test",
      budget_total: 150,
      per_purchase_approval_over: 60,
      allowed_categories: ["garden"],
      blocked_categories: [],
      max_quantity_per_item: 2,
      expires_at: new Date(Date.now() + 864e5).toISOString(),
    });
    s.mandate!.status = "active";

    const p = await proposePurchase(s, [{ product_id: "cat_injection_seedbox", qty: 1 }], "test", "http://localhost:0");
    expect(p.status).toBe("pending_approval");
    expect(p.error).toBeNull();
    expect(p.paypal).toMatchObject({ order_id: "5O190127TN364715T", approve_url: APPROVE, capture_id: null });

    const done = await completePurchaseApproval(s, p.id);
    expect(done.status).toBe("charged");
    expect(done.paypal).toMatchObject({ capture_id: "2GG279541U471931P", approve_url: null });
  });
});
