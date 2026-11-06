// One interface for every way of attaching spending power to a mandate (SPEC §5).
import type { Mandate, PaymentMode } from "../../shared/types.ts";

export interface RailUrls {
  /** Absolute URL PayPal sends the buyer back to after approval. */
  returnUrl: string;
  cancelUrl: string;
}

export interface AuthorizeResult {
  /** Where to send the buyer. May be relative (mock) or a PayPal URL. */
  approveUrl: string;
  /** Fields to merge into mandate.paypal (e.g. order_id). */
  paypal: Partial<Mandate["paypal"]>;
}

export type ChargeResult =
  | { status: "captured"; order_id: string | null; capture_id: string }
  /** per_purchase mode: the buyer must approve this one payment before it can be captured. */
  | { status: "payer_action_required"; order_id: string; approveUrl: string };

export interface ChargeRequest {
  purchaseId: string;
  amount: number;
  description: string;
  urls: RailUrls;
}

/** Register a (simulated) shipment for one capture with PayPal. */
export interface TrackRequest {
  purchaseId: string;
  /** The PayPal order the capture belongs to; null when unknown (the rail then uses trackers-batch). */
  orderId: string | null;
  captureId: string;
  trackingNumber: string;
  /** PayPal carrier enum; "OTHER" needs carrierNameOther. */
  carrier: string;
  carrierNameOther: string | null;
  items: { name: string; quantity: string }[];
}

export interface TrackResult {
  /** PayPal tracker id, `{capture_id}-{tracking_number}`. */
  tracker_id: string;
  /** Which PayPal API stored it. */
  via: "orders" | "trackers-batch" | "mock";
}

export interface PaymentRail {
  mode: PaymentMode;
  /** Step 1: create whatever the buyer approves once (authorization order, nothing, ...). */
  authorizeMandate(m: Mandate, urls: RailUrls): Promise<AuthorizeResult>;
  /** Step 2: buyer came back from PayPal with `token`; turn the approval into spending power. */
  finalize(m: Mandate, token: string): Promise<Partial<Mandate["paypal"]>>;
  /** Move money for one allowed purchase. Policy has already run. */
  charge(m: Mandate, req: ChargeRequest): Promise<ChargeResult>;
  /** per_purchase only: buyer approved the order for one purchase; capture it. */
  completeCharge?(m: Mandate, orderId: string, purchaseId: string): Promise<{ capture_id: string }>;
  refund(m: Mandate, captureId: string, amount: number, purchaseId: string): Promise<{ refund_id: string }>;
  /** Add shipment tracking to a capture. Optional: a rail without it simply ships nothing. */
  track?(m: Mandate, req: TrackRequest): Promise<TrackResult>;
  /** Kill spending power. Returns the PayPal id of the void (or null when nothing to void).
   *  nothing_to_void: PayPal refused the void because no uncaptured money is held (422
   *  PREVIOUSLY_CAPTURED: captures reached the authorized amount; PREVIOUSLY_VOIDED;
   *  AUTHORIZATION_EXPIRED). Spending power is gone either way. */
  revoke(m: Mandate): Promise<{ paypal_id: string | null; nothing_to_void?: boolean }>;
}

export class PaymentError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly debugId?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "PaymentError";
  }
}
