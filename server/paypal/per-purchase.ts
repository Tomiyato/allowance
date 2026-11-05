// Fallback rail: no up-front hold; every purchase is an Orders v2 CAPTURE order the buyer approves.
// The mandate still gates what the agent may *propose*; the buyer is the hard cap.
// Fallback rail: same REST client as the verified authorization rail, but this flow was not exercised against the sandbox.
import type { PaymentRail } from "./rail.ts";
import { PaymentError } from "./rail.ts";
import { approveLink, money, paypal, PAYPAL_BRAND_NAME, PAYPAL_REFUND_NOTE } from "./client.ts";

export function createPerPurchaseRail(): PaymentRail {
  return {
    mode: "per_purchase",

    async authorizeMandate(_m, urls) {
      // Nothing to approve up front: go straight back to our return handler.
      const u = new URL(urls.returnUrl);
      u.searchParams.set("token", "NONE");
      return { approveUrl: `${u.pathname}${u.search}`, paypal: {} };
    },

    async finalize() {
      return {};
    },

    // Fallback rail: same REST client as the verified authorization rail, but this flow was not exercised against the sandbox.
    async charge(_m, req) {
      const order = await paypal({
        method: "POST",
        path: "/v2/checkout/orders",
        requestId: `${req.purchaseId}-order`,
        body: {
          intent: "CAPTURE",
          purchase_units: [
            {
              reference_id: req.purchaseId,
              invoice_id: req.purchaseId,
              description: req.description.slice(0, 127),
              amount: money(req.amount),
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                brand_name: PAYPAL_BRAND_NAME,
                shipping_preference: "NO_SHIPPING",
                user_action: "PAY_NOW",
                return_url: req.urls.returnUrl,
                cancel_url: req.urls.cancelUrl,
              },
            },
          },
        },
      });
      return { status: "payer_action_required", order_id: order.id, approveUrl: approveLink(order) };
    },

    // Fallback rail: same REST client as the verified authorization rail, but this flow was not exercised against the sandbox.
    async completeCharge(_m, orderId, purchaseId) {
      const res = await paypal({
        method: "POST",
        path: `/v2/checkout/orders/${orderId}/capture`,
        requestId: `${purchaseId}-capture`,
        body: {},
      });
      const cap = res?.purchase_units?.[0]?.payments?.captures?.[0];
      if (!cap?.id) throw new PaymentError("Order capture response has no capture id.", undefined, res?.debug_id, res);
      return { capture_id: cap.id };
    },

    // Fallback rail: same REST client as the verified authorization rail, but this flow was not exercised against the sandbox.
    async refund(_m, captureId, amount, purchaseId) {
      const r = await paypal({
        method: "POST",
        path: `/v2/payments/captures/${captureId}/refund`,
        requestId: `${purchaseId}-refund`,
        body: { amount: money(amount), invoice_id: `${purchaseId}-r`, note_to_payer: PAYPAL_REFUND_NOTE },
      });
      if (!r?.id) throw new PaymentError("Refund response has no id.", undefined, r?.debug_id, r);
      return { refund_id: r.id };
    },

    async revoke() {
      // No standing PayPal object to cancel: revoking the mandate is enough.
      return { paypal_id: null };
    },
  };
}
