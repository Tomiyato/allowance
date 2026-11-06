// Shipment tracking for a capture. Ribbon has no real warehouse: after each capture it "ships" the gift
// with a clearly simulated carrier and tracking number, and registers that shipment with PayPal.
//
// Verified against the PayPal sandbox on 2026-11-06 (docs/research/paypal-sandbox-results.md, "Shipment
// tracking"): POST /v2/checkout/orders/{order_id}/track works for a capture made from an Orders v2
// AUTHORIZE order (also with shipping_preference NO_SHIPPING) and returns the order with
// purchase_units[0].shipping.trackers[] (id `{capture_id}-{tracking_number}`, status SHIPPED).
// POST /v1/shipping/trackers-batch (transaction_id = capture id) also works and is the fallback.
import { randomBytes } from "node:crypto";
import { paypal } from "./client.ts";
import { PaymentError, type TrackRequest, type TrackResult } from "./rail.ts";

/** PayPal carrier enum value for a carrier that is not in the list. */
export const DEMO_CARRIER = "OTHER";
/** carrier_name_other: says plainly that the shipment is simulated. */
export const DEMO_CARRIER_NAME = "Ribbon demo shipping";

const ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** "RIB" + 10 characters: a generated, obviously-demo tracking number (PayPal allows 1-64 characters). */
export function demoTrackingNumber(): string {
  const bytes = randomBytes(10);
  let out = "RIB";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

async function trackOnOrder(req: TrackRequest): Promise<TrackResult> {
  const order = await paypal({
    method: "POST",
    path: `/v2/checkout/orders/${req.orderId}/track`,
    requestId: `${req.purchaseId}-track`,
    body: {
      capture_id: req.captureId,
      tracking_number: req.trackingNumber,
      carrier: req.carrier,
      ...(req.carrier === "OTHER" && req.carrierNameOther ? { carrier_name_other: req.carrierNameOther } : {}),
      notify_payer: false,
      ...(req.items.length ? { items: req.items } : {}),
    },
  });
  const trackers: any[] = (order?.purchase_units ?? []).flatMap((u: any) => u?.shipping?.trackers ?? []);
  const expected = `${req.captureId}-${req.trackingNumber}`;
  const t = trackers.find((x) => x?.id === expected) ?? trackers.find((x) => String(x?.id ?? "").startsWith(`${req.captureId}-`));
  if (!t?.id) throw new PaymentError("Track response has no tracker for this capture.", undefined, order?.debug_id, order);
  return { tracker_id: t.id, via: "orders" };
}

async function trackBatch(req: TrackRequest): Promise<TrackResult> {
  const r = await paypal({
    method: "POST",
    path: "/v1/shipping/trackers-batch",
    requestId: `${req.purchaseId}-trackers-batch`,
    body: {
      trackers: [
        {
          transaction_id: req.captureId,
          tracking_number: req.trackingNumber,
          status: "SHIPPED",
          carrier: req.carrier,
          ...(req.carrier === "OTHER" && req.carrierNameOther ? { carrier_name_other: req.carrierNameOther } : {}),
          notify_buyer: false,
        },
      ],
    },
  });
  const err = r?.errors?.[0];
  if (err) throw new PaymentError(`trackers-batch rejected the tracker: ${err.details?.[0]?.issue ?? err.name ?? "ERROR"} ${err.message ?? ""}`.trim(), undefined, err.debug_id, r);
  const id = r?.tracker_identifiers?.[0];
  if (!id?.transaction_id) throw new PaymentError("trackers-batch response has no tracker.", undefined, r?.debug_id, r);
  return { tracker_id: `${id.transaction_id}-${id.tracking_number ?? req.trackingNumber}`, via: "trackers-batch" };
}

/**
 * Orders v2 track first (the current API); on any failure, the v1 trackers-batch API, which only needs
 * the capture id. Throws when both fail; the caller logs it and keeps the purchase.
 */
export async function trackCapture(req: TrackRequest): Promise<TrackResult> {
  if (!req.orderId) return trackBatch(req);
  try {
    return await trackOnOrder(req);
  } catch (first) {
    console.warn(`[paypal] orders track failed (${first instanceof Error ? first.message : String(first)}); trying trackers-batch`);
    try {
      return await trackBatch(req);
    } catch (second) {
      const a = first instanceof Error ? first.message : String(first);
      const b = second instanceof Error ? second.message : String(second);
      throw new PaymentError(`${a}; fallback: ${b}`, second instanceof PaymentError ? second.status : undefined);
    }
  }
}
