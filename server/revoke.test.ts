// Revoke on the authorization rail. Sandbox matrix 2026-11-05 (docs/research/paypal-sandbox-results.md):
// void succeeds after partial captures and refunds; 422 PREVIOUSLY_CAPTURED only once the captures reach
// the authorized amount. The ledger must then say nothing is left instead of "voided" (GIFTLIST_SPEC §4).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.STORE_FILE = `${process.env.TEMP ?? process.env.TMPDIR ?? "/tmp"}/allowance-test-rv-${process.pid}.json`;
  process.env.PAYMENT_MODE = "authorization";
  process.env.PAYPAL_CLIENT_ID = "test-client";
  process.env.PAYPAL_CLIENT_SECRET = "test-secret";
});

const paypal = vi.hoisted(() => vi.fn());
vi.mock("./paypal/client.ts", async (orig) => ({ ...(await orig<typeof import("./paypal/client.ts")>()), paypal, approveLink: () => "https://www.sandbox.paypal.com/checkoutnow?token=X" }));

import { PaymentError } from "./paypal/rail.ts";
import { rail } from "./paypal/index.ts";
import { createMandate, revokeMandate } from "./service.ts";
import { PAYPAL_SOFT_DESCRIPTOR } from "./paypal/client.ts";
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
  /** PaymentError as client.ts builds it from a PayPal 422 body. */
  const void422 = (issue: string) =>
    new PaymentError(`PayPal POST /v2/payments/authorizations/7RF41537SA567871A/void failed (422 ${issue}): x`, 422, "dbg", {
      name: "UNPROCESSABLE_ENTITY",
      details: [{ issue, description: "x" }],
    });

  it.each(["PREVIOUSLY_VOIDED", "AUTHORIZATION_EXPIRED"])("treats 422 %s as nothing held", async (issue) => {
    paypal.mockRejectedValueOnce(void422(issue));
    const s = activeWithAuthorization();
    await revokeMandate(s, s.mandate!.id);
    expect(s.ledger.find((r) => r.action === "paypal.void")?.summary).toBe("Nothing left on the PayPal authorization to void");
  });

  it("does not claim nothing was left on a 422 that means something else", async () => {
    paypal.mockRejectedValueOnce(void422("CANNOT_BE_VOIDED"));
    const s = activeWithAuthorization();
    await revokeMandate(s, s.mandate!.id);
    expect(s.ledger.some((r) => r.action === "paypal.void")).toBe(false);
    expect(s.ledger.some((r) => r.action === "paypal.error" && /CANNOT_BE_VOIDED/.test(r.summary))).toBe(true);
    expect(s.mandate!.status).toBe("revoked");
  });
});

describe("PayPal brand strings (authorization rail)", () => {
  beforeEach(() => paypal.mockReset());

  it("sends Ribbon as brand_name, soft_descriptor and refund note, within PayPal's limits", async () => {
    const s = activeWithAuthorization();
    const m = s.mandate!;
    paypal.mockResolvedValueOnce({ id: "ORDER1", links: [] });
    await rail.authorizeMandate(m, { returnUrl: "http://localhost:3202/paypal/return", cancelUrl: "http://localhost:3202/paypal/cancel" });
    const order = paypal.mock.calls[0][0].body;
    expect(order.payment_source.paypal.experience_context.brand_name).toBe("Ribbon");
    expect(order.purchase_units[0].description).not.toMatch(/allowance/i);

    paypal.mockResolvedValueOnce({ id: "CAP1", status: "COMPLETED" });
    await rail.charge(m, { purchaseId: "pur_1", amount: 12.5, description: "Gift for Mom", urls: { returnUrl: "", cancelUrl: "" } });
    const cap = paypal.mock.calls[1][0].body;
    expect(cap.soft_descriptor).toBe("RIBBON GIFTS");
    expect(PAYPAL_SOFT_DESCRIPTOR.length).toBeLessThanOrEqual(22);
    expect(cap.final_capture).toBe(false);

    paypal.mockResolvedValueOnce({ id: "REF1" });
    await rail.refund(m, "CAP1", 12.5, "pur_1");
    expect(paypal.mock.calls[2][0].body.note_to_payer).toBe("Returned via Ribbon");
  });
});
