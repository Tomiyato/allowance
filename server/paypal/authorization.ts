// Plan A rail: one Orders v2 AUTHORIZE for the whole budget, partial captures per purchase.
// PayPal itself then refuses to release more than was authorized (subject to PayPal's own
// over-capture rules — see assumptions in the report).
// UNTESTED against sandbox.
import type { PaymentRail } from "./rail.ts";
import { PaymentError } from "./rail.ts";
import { approveLink, money, paypal } from "./client.ts";

export function createAuthorizationRail(): PaymentRail {
  return {
    mode: "authorization",

    // UNTESTED against sandbox
    async authorizeMandate(m, urls) {
      const order = await paypal({
        method: "POST",
        path: "/v2/checkout/orders",
        requestId: `${m.id}-order`,
        body: {
          intent: "AUTHORIZE",
          purchase_units: [
            {
              reference_id: m.id,
              custom_id: m.id,
              description: `Allowance mandate: ${m.title}`.slice(0, 127),
              amount: money(m.budget_total),
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                brand_name: "Allowance",
                shipping_preference: "NO_SHIPPING",
                user_action: "CONTINUE",
                return_url: urls.returnUrl,
                cancel_url: urls.cancelUrl,
              },
            },
          },
        },
      });
      return { approveUrl: approveLink(order), paypal: { order_id: order.id } };
    },

    // UNTESTED against sandbox
    async finalize(m, token) {
      const orderId = m.paypal.order_id ?? token;
      if (token && m.paypal.order_id && token !== m.paypal.order_id) {
        throw new PaymentError(`Return token ${token} does not match the mandate's order ${m.paypal.order_id}.`);
      }
      const res = await paypal({
        method: "POST",
        path: `/v2/checkout/orders/${orderId}/authorize`,
        requestId: `${m.id}-authorize`,
        body: {},
      });
      const auth = res?.purchase_units?.[0]?.payments?.authorizations?.[0];
      if (!auth?.id) throw new PaymentError("Authorize response has no authorization id.", undefined, res?.debug_id, res);
      if (auth.status && auth.status !== "CREATED") {
        throw new PaymentError(`Authorization status is ${auth.status}, expected CREATED.`, undefined, undefined, res);
      }
      return { order_id: orderId, authorization_id: auth.id };
    },

    // UNTESTED against sandbox
    async charge(m, req) {
      if (!m.paypal.authorization_id) throw new PaymentError("Mandate has no PayPal authorization.");
      const cap = await paypal({
        method: "POST",
        path: `/v2/payments/authorizations/${m.paypal.authorization_id}/capture`,
        requestId: `${req.purchaseId}-capture`,
        body: {
          amount: money(req.amount),
          final_capture: false,
          invoice_id: req.purchaseId,
          note_to_payer: req.description.slice(0, 255),
          soft_descriptor: "ALLOWANCE",
        },
      });
      if (!cap?.id) throw new PaymentError("Capture response has no id.", undefined, cap?.debug_id, cap);
      if (cap.status && !["COMPLETED", "PENDING"].includes(cap.status)) {
        throw new PaymentError(`Capture status is ${cap.status}.`, undefined, undefined, cap);
      }
      return { status: "captured", order_id: m.paypal.order_id, capture_id: cap.id };
    },

    // UNTESTED against sandbox
    async refund(_m, captureId, amount, purchaseId) {
      const r = await paypal({
        method: "POST",
        path: `/v2/payments/captures/${captureId}/refund`,
        requestId: `${purchaseId}-refund`,
        body: { amount: money(amount), invoice_id: `${purchaseId}-r`, note_to_payer: "Returned via Allowance" },
      });
      if (!r?.id) throw new PaymentError("Refund response has no id.", undefined, r?.debug_id, r);
      return { refund_id: r.id };
    },

    // UNTESTED against sandbox
    async revoke(m) {
      if (!m.paypal.authorization_id) return { paypal_id: null };
      try {
        await paypal({
          method: "POST",
          path: `/v2/payments/authorizations/${m.paypal.authorization_id}/void`,
          requestId: `${m.id}-void`,
        });
      } catch (e) {
        // Fully captured or already voided authorizations cannot be voided; nothing is left to hold then.
        if (e instanceof PaymentError && e.status === 422) {
          console.warn(`[paypal] void returned 422 (likely already captured/voided): ${e.message}`);
        } else throw e;
      }
      return { paypal_id: m.paypal.authorization_id };
    },
  };
}
