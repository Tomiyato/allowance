// Revoke on the authorization rail: a 422 on void (e.g. PREVIOUSLY_CAPTURED) means nothing is left on
// the authorization; the ledger must say so instead of "voided" (GIFTLIST_SPEC §4).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.STORE_FILE = `${process.env.TEMP ?? process.env.TMPDIR ?? "/tmp"}/allowance-test-rv-${process.pid}.json`;
  process.env.PAYMENT_MODE = "authorization";
  process.env.PAYPAL_CLIENT_ID = "test-client";
  process.env.PAYPAL_CLIENT_SECRET = "test-secret";
});

const paypal = vi.hoisted(() => vi.fn());
vi.mock("./paypal/client.ts", () => ({ paypal, money: (n: number) => ({ currency_code: "USD", value: n.toFixed(2) }), approveLink: () => "" }));

import { PaymentError } from "./paypal/rail.ts";
import { rail } from "./paypal/index.ts";
import { createMandate, revokeMandate } from "./service.ts";
import { createSession } from "./store.ts";

function activeWithAuthorization() {
  const s = createSession();
  createMandate(s, {
    title: "Holiday gifts",
    per_purchase_approval_over: 45,
    blocked_categories: ["electronics"],
    recipients: [{ name: "Mom", envelope: 60, interests: "gardening" }],
  });
  s.mandate!.status = "active";
  s.mandate!.paypal.authorization_id = "7RF41537SA567871A";
  return s;
}

describe("revoke on the authorization rail", () => {
  beforeEach(() => paypal.mockReset());

  it("uses the authorization rail in this test", () => {
    expect(rail.mode).toBe("authorization");
  });

  it("says the hold was voided when PayPal voids it", async () => {
    paypal.mockResolvedValueOnce(undefined);
    const s = activeWithAuthorization();
    await revokeMandate(s, s.mandate!.id);
    expect(paypal).toHaveBeenCalledWith(expect.objectContaining({ path: "/v2/payments/authorizations/7RF41537SA567871A/void" }));
    const row = s.ledger.find((r) => r.action === "paypal.void")!;
    expect(row).toMatchObject({ summary: "PayPal authorization voided; remaining hold released", paypal_id: "7RF41537SA567871A" });
    expect(s.mandate!.status).toBe("revoked");
  });

  it("says nothing was left to void when PayPal answers 422 PREVIOUSLY_CAPTURED", async () => {
    paypal.mockRejectedValueOnce(
      new PaymentError("PayPal POST /v2/payments/authorizations/7RF41537SA567871A/void failed (422 PREVIOUSLY_CAPTURED): Authorization has been previously captured", 422),
    );
    const s = activeWithAuthorization();
    await revokeMandate(s, s.mandate!.id);
    const row = s.ledger.find((r) => r.action === "paypal.void")!;
    expect(row.summary).toBe("Nothing left on the PayPal authorization to void");
    expect(s.ledger.some((r) => /voided/.test(r.summary))).toBe(false);
    expect(s.ledger.some((r) => r.action === "paypal.error")).toBe(false);
    expect(s.mandate!.status).toBe("revoked");
  });

  it("still revokes and logs a PayPal error on any other void failure", async () => {
    paypal.mockRejectedValueOnce(new PaymentError("PayPal POST ... failed (500 INTERNAL_SERVER_ERROR): boom", 500));
    const s = activeWithAuthorization();
    await revokeMandate(s, s.mandate!.id);
    expect(s.ledger.some((r) => r.action === "paypal.error" && /PayPal void failed/.test(r.summary))).toBe(true);
    expect(s.ledger.some((r) => r.action === "paypal.void")).toBe(false);
    expect(s.mandate!.status).toBe("revoked");
  });
});
