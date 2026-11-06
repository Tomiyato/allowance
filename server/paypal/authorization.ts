// Plan A rail: one Orders v2 AUTHORIZE for the whole budget, partial captures per purchase, void on revoke.
// PayPal is the outer bound: once the authorization is used up it refuses further captures, but it
// accepted an over-capture on the capture that exhausted it (sandbox), so the policy engine owns the
// exact budget.
// Verified against the PayPal sandbox: see docs/research/paypal-sandbox-results.md.
import type { PaymentRail } from "./rail.ts";
import { PaymentError } from "./rail.ts";
import { approveLink, money, paypal, PAYPAL_BRAND_NAME, PAYPAL_REFUND_NOTE, PAYPAL_SOFT_DESCRIPTOR } from "./client.ts";
import { trackCapture } from "./tracking.ts";

export function createAuthorizationRail(): PaymentRail {
  return {
    mode: "authorization",

    // Verified against the PayPal sandbox on 2026-11-04 (see docs/research/paypal-sandbox-results.md).
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
              description: `Gift list: ${m.title}`.slice(0, 127),
              amount: money(m.budget_total),
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                brand_name: PAYPAL_BRAND_NAME,
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

    // Verified against the PayPal sandbox on 2026-11-04 (see docs/research/paypal-sandbox-results.md).
    async finalize(m, token) {
      const orderId = m.paypal.order_id ?? token;
      if (token && m.paypal.order_id && token !== m.paypal.order_id) {
        throw new PaymentError(`Return token ${token} does not match the gift list's order ${m.paypal.order_id}.`);
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

    // Verified against the PayPal sandbox on 2026-11-04 (see docs/research/paypal-sandbox-results.md).
    async charge(m, req) {
      if (!m.paypal.authorization_id) throw new PaymentError("The gift list has no PayPal authorization.");
      const cap = await paypal({
        method: "POST",
        path: `/v2/payments/authorizations/${m.paypal.authorization_id}/capture`,
        requestId: `${req.purchaseId}-capture`,
        body: {
          amount: money(req.amount),
          final_capture: false,
          invoice_id: req.purchaseId,
          note_to_payer: req.description.slice(0, 255),
          soft_descriptor: PAYPAL_SOFT_DESCRIPTOR,
        },
      });
      if (!cap?.id) throw new PaymentError("Capture response has no id.", undefined, cap?.debug_id, cap);
      if (cap.status && !["COMPLETED", "PENDING"].includes(cap.status)) {
        throw new PaymentError(`Capture status is ${cap.status}.`, undefined, undefined, cap);
      }
      return { status: "captured", order_id: m.paypal.order_id, capture_id: cap.id };
    },

    // Verified against the PayPal sandbox on 2026-11-04 (see docs/research/paypal-sandbox-results.md).
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

    // Verified against the PayPal sandbox on 2026-11-06 (docs/research/paypal-sandbox-results.md, shipment tracking):
    // Orders v2 track accepts a capture made from this AUTHORIZE order; trackers-batch is the fallback.
    async track(m, req) {
      return trackCapture({ ...req, orderId: req.orderId ?? m.paypal.order_id });
    },

    // Verified against the PayPal sandbox on 2026-11-05 (docs/research/paypal-sandbox-results.md, void matrix):
    // void succeeds (200, status VOIDED) while the captures total less than the authorized amount,
    // after any number of partial captures and refunds, and releases the uncaptured remainder.
    // Once the captures reach the authorized amount the authorization is CAPTURED and void answers
    // 422 PREVIOUSLY_CAPTURED (refunds do not reopen it): nothing uncaptured is held then.
    async revoke(m) {
      if (!m.paypal.authorization_id) return { paypal_id: null };
      try {
        await paypal({
          method: "POST",
          path: `/v2/payments/authorizations/${m.paypal.authorization_id}/void`,
          requestId: `${m.id}-void`,
        });
      } catch (e) {
        const issue = paypalIssue(e);
        if (e instanceof PaymentError && e.status === 422 && issue && NOTHING_HELD.has(issue)) {
          console.warn(`[paypal] void returned 422 ${issue}: nothing uncaptured is held on the authorization.`);
          return { paypal_id: m.paypal.authorization_id, nothing_to_void: true };
        }
        throw e;
      }
      return { paypal_id: m.paypal.authorization_id };
    },
  };
}

/** Void 422 issues that mean no uncaptured money is held: fully captured, already voided, expired. */
const NOTHING_HELD = new Set(["PREVIOUSLY_CAPTURED", "PREVIOUSLY_VOIDED", "AUTHORIZATION_EXPIRED"]);

function paypalIssue(e: unknown): string | undefined {
  if (!(e instanceof PaymentError)) return undefined;
  const d = e.details as any;
  return d?.details?.[0]?.issue ?? /\(\d{3} ([A-Z_]+)\)/.exec(e.message)?.[1];
}
