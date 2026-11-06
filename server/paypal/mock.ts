// MOCK payment rail: no network, no money. Dev-only; the UI labels it via state.mode.payment === "mock".
// IDs look like PayPal IDs but carry a MOCK- prefix so they can never be mistaken for real ones.
import { randomBytes } from "node:crypto";
import type { PaymentRail } from "./rail.ts";

const fakeId = (len = 17) =>
  "MOCK-" +
  randomBytes(len)
    .toString("base64")
    .replace(/[^A-Z0-9]/gi, "")
    .toUpperCase()
    .slice(0, len - 5)
    .padEnd(len - 5, "7");

export function createMockRail(): PaymentRail {
  return {
    mode: "mock",
    async authorizeMandate(m, urls) {
      const orderId = fakeId();
      const u = new URL(urls.returnUrl);
      u.searchParams.set("token", "MOCK");
      // Same-origin relative URL: the "PayPal approval" is skipped entirely.
      return { approveUrl: `${u.pathname}${u.search}`, paypal: { order_id: orderId } };
    },
    async finalize() {
      return { authorization_id: fakeId() };
    },
    async charge() {
      return { status: "captured", order_id: null, capture_id: fakeId() };
    },
    async refund() {
      return { refund_id: fakeId() };
    },
    async track(_m, req) {
      return { tracker_id: `${req.captureId}-${req.trackingNumber}`, via: "mock" };
    },
    async revoke(m) {
      return { paypal_id: m.paypal.authorization_id };
    },
  };
}
