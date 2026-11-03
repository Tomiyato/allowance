import { config } from "../config.ts";
import { createAuthorizationRail } from "./authorization.ts";
import { createMockRail } from "./mock.ts";
import { createPerPurchaseRail } from "./per-purchase.ts";
import type { PaymentRail } from "./rail.ts";

export type { PaymentRail, ChargeResult, RailUrls } from "./rail.ts";
export { PaymentError } from "./rail.ts";

function select(): PaymentRail {
  switch (config.paymentMode) {
    case "authorization":
      return createAuthorizationRail();
    case "per_purchase":
      return createPerPurchaseRail();
    default:
      return createMockRail();
  }
}

export const rail: PaymentRail = select();
